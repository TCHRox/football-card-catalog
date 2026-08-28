const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FootballCardArchiveBot/1.0)"
};

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function typeVariants(type) {
  const raw = String(type || "").trim();
  if (!raw) return [""];
  const variants = new Set();
  variants.add(raw);
  variants.add(raw.replace(/\bset\b/ig, "").trim());
  variants.add(raw.replace(/\bcard\b/ig, "").trim());
  if (/^base set$/i.test(raw)) variants.add("base");
  if (/^base\/subset$/i.test(raw)) variants.add("base");
  return [...variants].filter(Boolean);
}

function buildCandidateUrls({ player, year, brand, type, number }) {
  const playerSlug = slugify(`${player}-football`);
  const brandSlug = slugify(brand);
  const num = String(number || "").trim();
  const urls = new Set();

  for (const variant of typeVariants(type)) {
    const typeSlug = slugify(variant);
    if (playerSlug && year && brandSlug && typeSlug && num) {
      urls.add(`https://www.sportscardinvestor.com/cards/${playerSlug}/${year}-${brandSlug}-${typeSlug}-${num}`);
    }
    if (playerSlug && year && brandSlug && num) {
      urls.add(`https://www.sportscardinvestor.com/cards/${playerSlug}/${year}-${brandSlug}-${num}`);
    }
  }

  return [...urls];
}

function extractImageUrl(html) {
  if (!html) return "";
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /(https:\/\/images\.production\.sportscardinvestor\.com\/[^"' <]+)/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }

  return "";
}

async function tryUrl(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) return null;

  const html = await response.text();
  const imageUrl = extractImageUrl(html);
  if (!imageUrl) return null;

  return { imageUrl, sourcePage: url };
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const player = url.searchParams.get("player") || "";
    const year = url.searchParams.get("year") || "";
    const brand = url.searchParams.get("brand") || "";
    const type = url.searchParams.get("type") || "";
    const number = url.searchParams.get("number") || "";

    if (!player || !year || !brand || !number) {
      return new Response(JSON.stringify({
        error: "Missing required query parameters."
      }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    const candidates = buildCandidateUrls({ player, year, brand, type, number });

    for (const candidate of candidates) {
      try {
        const result = await tryUrl(candidate);
        if (result?.imageUrl) {
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "public, max-age=86400"
            }
          });
        }
      } catch {
        // keep trying next candidate
      }
    }

    return new Response(JSON.stringify({
      imageUrl: "",
      sourcePage: "",
      tried: candidates
    }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
