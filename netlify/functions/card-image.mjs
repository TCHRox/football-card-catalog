const SERPER_ENDPOINT = "https://google.serper.dev/images";

const SOURCE_PRIORITIES = [
  ["sportscardinvestor.com", 35],
  ["comc.com", 24],
  ["sportscardspro.com", 22],
  ["beckett.com", 18],
  ["ebay.com", 12],
  ["130point.com", 10]
];

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();
}

function words(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function hasAll(haystack, values) {
  const text = normalize(haystack);
  return values.every(v => text.includes(normalize(v)));
}

function domainScore(domain) {
  const d = String(domain || "").toLowerCase();
  for (const [needle, score] of SOURCE_PRIORITIES) {
    if (d.includes(needle)) return score;
  }
  return 0;
}

function scoreResult(result, card) {
  const title = String(result.title || "");
  const domain = String(result.domain || "");
  const combined = `${title} ${result.link || ""} ${domain}`;
  const normalizedCombined = normalize(combined);

  let score = domainScore(domain);

  const playerTokens = words(card.player);
  const brandTokens = words(card.brand);
  const typeTokens = words(card.type);
  const noteTokens = words(card.notes).slice(0, 5);

  if (playerTokens.length && playerTokens.every(t => normalizedCombined.includes(t))) score += 24;
  else if (playerTokens.some(t => normalizedCombined.includes(t))) score += 7;

  if (card.year && normalizedCombined.includes(normalize(card.year))) score += 9;

  if (brandTokens.length && brandTokens.every(t => normalizedCombined.includes(t))) score += 11;
  else if (brandTokens.some(t => normalizedCombined.includes(t))) score += 4;

  const number = String(card.number || "").trim();
  if (number) {
    const numberPatterns = [
      `#${number}`.toLowerCase(),
      ` ${number} `,
      `-${number}`,
      `/${number}`
    ];
    if (numberPatterns.some(p => String(combined).toLowerCase().includes(p))) score += 18;
  }

  if (typeTokens.length && typeTokens.some(t => normalizedCombined.includes(t))) score += 7;
  if (noteTokens.length && noteTokens.some(t => normalizedCombined.includes(t))) score += 5;

  if (String(card.rookie).toUpperCase() === "Y" &&
      /\b(rc|rookie)\b/i.test(title)) {
    score += 4;
  }

  // Prefer a normal portrait card-shaped image.
  const width = Number(result.imageWidth || 0);
  const height = Number(result.imageHeight || 0);
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio >= 0.52 && ratio <= 0.86) score += 8;
    else if (ratio > 1.05) score -= 8;
  }

  // Avoid likely wrong product formats.
  const penalties = [
    [/\blot\b/i, 18],
    [/\bteam set\b/i, 15],
    [/\bcomplete set\b/i, 15],
    [/\byou pick\b/i, 14],
    [/\bpick your\b/i, 14],
    [/\breprint\b/i, 18],
    [/\bcustom\b/i, 18],
    [/\bdigital\b/i, 20],
    [/\bback\b/i, 5]
  ];

  for (const [pattern, penalty] of penalties) {
    if (pattern.test(title)) score -= penalty;
  }

  // The collection currently appears to be raw cards, so slab images are less desirable.
  if (/\b(psa|bgs|sgc|cgc|graded|slab)\b/i.test(title)) score -= 10;

  return score;
}

function buildQuery(card) {
  const parts = [
    `"${card.player}"`,
    card.year,
    card.brand,
    card.type,
    card.number ? `#${card.number}` : "",
    String(card.rookie).toUpperCase() === "Y" ? "rookie RC" : "",
    card.notes,
    "football card"
  ];
  return parts.filter(Boolean).join(" ");
}

function pickBest(images, card) {
  const ranked = (images || [])
    .map(result => ({
      ...result,
      _score: scoreResult(result, card)
    }))
    .filter(result => result.imageUrl || result.thumbnailUrl)
    .sort((a, b) => b._score - a._score);

  // Refuse very weak matches instead of confidently showing the wrong card.
  const best = ranked[0];
  if (!best || best._score < 35) return null;

  return best;
}

export default async (request) => {
  try {
    const apiKey = process.env.SERPER_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({
        error: "SERPER_API_KEY is not configured.",
        code: "SERPER_NOT_CONFIGURED"
      }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

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
        error: "Missing player, year, brand, or card number."
      }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    const searchResponse = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: buildQuery(card),
        gl: "us",
        hl: "en",
        num: 20
      })
    });

    if (!searchResponse.ok) {
      const text = await searchResponse.text();
      return new Response(JSON.stringify({
        error: `Image search provider returned ${searchResponse.status}.`,
        providerBody: text.slice(0, 300)
      }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    const data = await searchResponse.json();
    const best = pickBest(data.images || [], card);

    if (!best) {
      return new Response(JSON.stringify({
        imageUrl: "",
        sourcePage: "",
        source: "",
        matchTitle: "",
        query: buildQuery(card)
      }), {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "Netlify-CDN-Cache-Control": "public, durable, max-age=3600"
        }
      });
    }

    // Google-cached thumbnails are substantially more reliable for embedding
    // than arbitrary seller/site hotlinks. Keep the original URL for future detail views.
    const displayUrl = best.thumbnailUrl || best.imageUrl;

    return new Response(JSON.stringify({
      imageUrl: displayUrl,
      originalImageUrl: best.imageUrl || "",
      sourcePage: best.link || "",
      source: best.source || best.domain || "",
      domain: best.domain || "",
      matchTitle: best.title || "",
      matchScore: best._score,
      query: buildQuery(card)
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=2592000",
        "Netlify-CDN-Cache-Control": "public, durable, max-age=2592000"
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
