const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const SEARCH_HEADERS = {
  ...DEFAULT_HEADERS,
  "Referer": "https://www.sportscardinvestor.com/cards"
};

function slugify(value, apostropheMode = "separator") {
  let text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  text = apostropheMode === "separator"
    ? text.replace(/[’']/g, "-")
    : text.replace(/[’']/g, "");

  return text
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function normalizeBrandVariants(brand) {
  const raw = String(brand || "").trim();
  const cleanPanini = raw.replace(/^panini\s+/i, "").trim();
  const variants = new Set([raw, cleanPanini]);

  const lower = cleanPanini.toLowerCase();

  // Common collection-sheet wording vs Sports Card Investor set names.
  if (lower === "donruss optics" || lower === "donruss optic" || lower === "optic") {
    variants.add("Optic");
    variants.add("Donruss Optic");
  }

  if (lower === "donruss") variants.add("Donruss");
  if (lower === "prizm") variants.add("Prizm");
  if (lower === "score") variants.add("Score");
  if (lower === "phoenix") variants.add("Phoenix");
  if (lower === "absolute") variants.add("Absolute");
  if (lower === "select") variants.add("Select");
  if (lower === "mosaic") variants.add("Mosaic");
  if (lower === "prestige") variants.add("Prestige");

  return [...variants]
    .map(v => slugify(v))
    .filter(Boolean);
}

function usefulNotesVariants(notes) {
  const raw = String(notes || "").trim();
  if (!raw) return [];

  return raw
    .split(/[;,|]+/)
    .map(v => v.trim())
    .filter(v => v && v.length <= 60);
}

function typeVariants(type, notes) {
  const raw = String(type || "").trim();
  const variants = new Set();

  if (raw) {
    variants.add(raw);
    variants.add(raw.replace(/\bset\b/ig, "").trim());
    variants.add(raw.replace(/\bcard\b/ig, "").trim());
  }

  if (/^base set$/i.test(raw) || /^base$/i.test(raw)) variants.add("base");

  // "Parallel" by itself is not specific enough. Notes may contain the
  // actual parallel name, such as Silver, Refractor, Green, etc.
  if (/^parallel$/i.test(raw)) {
    for (const note of usefulNotesVariants(notes)) variants.add(note);
  }

  // Always keep a Base candidate for rows explicitly identified as Base.
  if (/base/i.test(raw)) variants.add("base");

  return [...variants].filter(Boolean);
}

function buildCandidateUrls({ player, year, brand, type, number, notes }) {
  const playerSlugs = [
    slugify(`${player}-football`, "separator"),
    slugify(`${player}-football`, "remove")
  ].filter(Boolean);

  const brandSlugs = normalizeBrandVariants(brand);
  const num = String(number || "").trim();
  const urls = new Set();
  const typeList = typeVariants(type, notes);

  for (const playerSlug of [...new Set(playerSlugs)]) {
    for (const brandSlug of [...new Set(brandSlugs)]) {
      for (const variant of typeList) {
        const typeSlug = slugify(variant);

        if (playerSlug && year && brandSlug && typeSlug && num) {
          urls.add(`https://www.sportscardinvestor.com/cards/${playerSlug}/${year}-${brandSlug}-${typeSlug}-${num}`);
        }
      }

      // Some SCI pages omit a variant token.
      if (playerSlug && year && brandSlug && num) {
        urls.add(`https://www.sportscardinvestor.com/cards/${playerSlug}/${year}-${brandSlug}-${num}`);
      }

      // Only use Base as a safe fallback when the row itself says Base.
      if (/base/i.test(String(type || "")) && playerSlug && year && brandSlug && num) {
        urls.add(`https://www.sportscardinvestor.com/cards/${playerSlug}/${year}-${brandSlug}-base-${num}`);
      }
    }
  }

  return [...urls].slice(0, 10);
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
    if (match && match[1]) return match[1].replace(/&amp;/g, "&");
  }

  return "";
}

function looksLikeSciCardPage(html, { player, year, number }) {
  const text = String(html || "").toLowerCase();
  const playerBits = String(player || "").toLowerCase()
    .replace(/[’']/g, "")
    .split(/\s+/)
    .filter(Boolean);

  const playerMatch = playerBits.every(bit => text.includes(bit));
  const yearMatch = !year || text.includes(String(year).toLowerCase());
  const numberMatch = !number ||
    text.includes(`#${String(number).toLowerCase()}`) ||
    text.includes(`>${String(number).toLowerCase()}<`) ||
    text.includes(` ${String(number).toLowerCase()} `);

  return playerMatch && yearMatch && numberMatch;
}

async function fetchPage(url, headers = DEFAULT_HEADERS) {
  const response = await fetch(url, {
    headers,
    redirect: "follow"
  });

  if ([403, 429, 503].includes(response.status)) {
    return {
      rateLimited: true,
      status: response.status,
      retryAfterMs: Math.max(
        5000,
        Number(response.headers.get("retry-after") || 0) * 1000
      )
    };
  }

  if (!response.ok) return { found: false, status: response.status };

  const html = await response.text();
  return { found: true, html, finalUrl: response.url || url };
}

async function trySciUrl(url, card) {
  const page = await fetchPage(url);

  if (page.rateLimited) return page;
  if (!page.found) return null;

  const imageUrl = extractImageUrl(page.html);
  if (!imageUrl) return null;

  // Avoid accepting unrelated soft-404 or redirect pages.
  if (!looksLikeSciCardPage(page.html, card)) return null;

  return {
    imageUrl,
    sourcePage: page.finalUrl || url,
    source: "Sports Card Investor"
  };
}

function decodeDuckDuckGoResultUrl(value) {
  try {
    let url = String(value || "").replace(/&amp;/g, "&");

    if (url.startsWith("//")) url = `https:${url}`;

    const parsed = new URL(url, "https://html.duckduckgo.com");

    if (parsed.hostname.includes("duckduckgo.com") && parsed.searchParams.get("uddg")) {
      return decodeURIComponent(parsed.searchParams.get("uddg"));
    }

    return parsed.href;
  } catch {
    return "";
  }
}

function extractSciSearchResultUrls(html) {
  const urls = new Set();

  const hrefPattern = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html))) {
    const decoded = decodeDuckDuckGoResultUrl(match[1]);
    if (/^https:\/\/www\.sportscardinvestor\.com\/cards\//i.test(decoded)) {
      urls.add(decoded.replace(/[?#].*$/, ""));
    }
  }

  // Also catch SCI URLs that appear as plain text in the search HTML.
  const rawPattern = /https:\/\/www\.sportscardinvestor\.com\/cards\/[a-zA-Z0-9\-_/]+/gi;
  while ((match = rawPattern.exec(html))) {
    urls.add(match[0].replace(/[?#].*$/, ""));
  }

  return [...urls];
}

function scoreSciUrl(url, { player, year, brand, type, number, notes }) {
  const haystack = slugify(url);
  const tokens = [
    ...String(player || "").split(/\s+/),
    year,
    ...String(brand || "").split(/\s+/),
    number,
    ...String(type || "").split(/\s+/),
    ...usefulNotesVariants(notes).flatMap(v => v.split(/\s+/))
  ]
    .map(slugify)
    .filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }

  if (number && haystack.endsWith(`-${slugify(number)}`)) score += 4;
  if (year && haystack.includes(slugify(year))) score += 2;

  return score;
}

async function searchSci(card) {
  const query = [
    `"${card.player}"`,
    card.year,
    card.brand,
    card.type,
    card.number,
    card.notes,
    "site:sportscardinvestor.com/cards"
  ].filter(Boolean).join(" ");

  const searchUrl =
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const result = await fetchPage(searchUrl, SEARCH_HEADERS);

  if (result.rateLimited) return result;
  if (!result.found) return null;

  const candidates = extractSciSearchResultUrls(result.html)
    .sort((a, b) => scoreSciUrl(b, card) - scoreSciUrl(a, card))
    .slice(0, 4);

  for (const candidate of candidates) {
    const hit = await trySciUrl(candidate, card);
    if (hit?.rateLimited) return hit;
    if (hit?.imageUrl) return hit;
  }

  return null;
}

export default async (request) => {
  try {
    const url = new URL(request.url);

    const card = {
      player: url.searchParams.get("player") || "",
      year: url.searchParams.get("year") || "",
      brand: url.searchParams.get("brand") || "",
      type: url.searchParams.get("type") || "",
      number: url.searchParams.get("number") || "",
      rookie: url.searchParams.get("rookie") || "",
      notes: url.searchParams.get("notes") || ""
    };

    if (!card.player || !card.year || !card.brand || !card.number) {
      return new Response(JSON.stringify({
        error: "Missing required query parameters."
      }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // 1. Fast path: construct likely SCI URLs.
    const candidates = buildCandidateUrls(card);

    for (const candidate of candidates) {
      const result = await trySciUrl(candidate, card);

      if (result?.rateLimited) {
        return new Response(JSON.stringify({
          error: "Sports Card Investor temporarily rate limited the lookup.",
          retryAfterMs: result.retryAfterMs || 7000
        }), {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(Math.ceil((result.retryAfterMs || 7000) / 1000))
          }
        });
      }

      if (result?.imageUrl) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=86400"
          }
        });
      }
    }

    // 2. Fallback: web-search specifically for a matching SCI card page.
    const searched = await searchSci(card);

    if (searched?.rateLimited) {
      return new Response(JSON.stringify({
        error: "Image lookup temporarily rate limited.",
        retryAfterMs: searched.retryAfterMs || 7000
      }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(Math.ceil((searched.retryAfterMs || 7000) / 1000))
        }
      });
    }

    if (searched?.imageUrl) {
      return new Response(JSON.stringify(searched), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=86400"
        }
      });
    }

    return new Response(JSON.stringify({
      imageUrl: "",
      sourcePage: "",
      source: "",
      tried: candidates
    }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600"
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
