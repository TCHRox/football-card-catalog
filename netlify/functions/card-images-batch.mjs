const SERPER_ENDPOINT = "https://google.serper.dev/images";
const MAX_CARDS = 8;

const SOURCE_PRIORITIES = [
  ["sportscardinvestor.com", 38],
  ["comc.com", 28],
  ["sportscardspro.com", 24],
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

function domainScore(domain) {
  const d = String(domain || "").toLowerCase();
  for (const [needle, score] of SOURCE_PRIORITIES) {
    if (d.includes(needle)) return score;
  }
  return 0;
}

function isTrustedCardDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return SOURCE_PRIORITIES.some(([needle]) => d.includes(needle));
}

function normalizedBrandTokens(brand) {
  const raw = normalize(brand);
  const tokens = words(raw);

  // Common catalog naming differences.
  if (/donruss optics?/.test(raw)) return ["donruss", "optic"];
  return tokens;
}

function scoreResult(result, card) {
  const title = String(result.title || "");
  const domain = String(result.domain || "");
  const link = String(result.link || "");
  const combined = `${title} ${link} ${domain}`;
  const haystack = normalize(combined);

  let score = domainScore(domain);

  const playerTokens = words(card.player);
  const brandTokens = normalizedBrandTokens(card.brand);
  const typeTokens = words(card.type);
  const noteTokens = words(card.notes).slice(0, 6);

  const fullPlayer = playerTokens.length &&
    playerTokens.every(token => haystack.includes(token));
  if (fullPlayer) score += 32;
  else if (playerTokens.some(token => haystack.includes(token))) score += 7;

  if (card.year && haystack.includes(normalize(card.year))) score += 14;

  const fullBrand = brandTokens.length &&
    brandTokens.every(token => haystack.includes(token));
  if (fullBrand) score += 16;
  else if (brandTokens.some(token => haystack.includes(token))) score += 5;

  const number = String(card.number || "").trim();
  if (number) {
    const lower = combined.toLowerCase();
    const patterns = [
      `#${number}`.toLowerCase(),
      ` ${number} `,
      `-${number}`,
      `/${number}`,
      `number ${number}`.toLowerCase()
    ];
    if (patterns.some(pattern => lower.includes(pattern))) score += 25;
  }

  if (typeTokens.length && typeTokens.some(token => haystack.includes(token))) {
    score += 8;
  }

  if (noteTokens.length && noteTokens.some(token => haystack.includes(token))) {
    score += 6;
  }

  if (
    String(card.rookie).toUpperCase() === "Y" &&
    /\b(rc|rookie)\b/i.test(title)
  ) {
    score += 4;
  }

  const width = Number(result.imageWidth || 0);
  const height = Number(result.imageHeight || 0);
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio >= .52 && ratio <= .86) score += 9;
    if (ratio > 1.05) score -= 10;
  }

  const penalties = [
    [/\blot\b/i, 20],
    [/\bteam set\b/i, 18],
    [/\bcomplete set\b/i, 18],
    [/\byou pick\b/i, 16],
    [/\bpick your\b/i, 16],
    [/\breprint\b/i, 25],
    [/\bcustom\b/i, 25],
    [/\bdigital\b/i, 25],
    [/\bchecklist\b/i, 12]
  ];

  for (const [pattern, penalty] of penalties) {
    if (pattern.test(title)) score -= penalty;
  }

  if (/\b(psa|bgs|sgc|cgc|graded|slab)\b/i.test(title)) {
    score -= 8;
  }

  // We require the identity fields that matter most. This is deliberately
  // stricter than just accepting Google's first image.
  if (!fullPlayer) score -= 25;
  if (card.year && !haystack.includes(normalize(card.year))) score -= 16;
  if (brandTokens.length && !brandTokens.some(t => haystack.includes(t))) score -= 14;

  return score;
}

function safeQueryText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Avoid search operators / exact-match syntax that free Serper accounts
    // may reject. Apostrophes and punctuation become ordinary spaces.
    .replace(/["'`:#()+\[\]{}<>|\\/]/g, " ")
    .replace(/[–—_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQueries(card) {
  const player = safeQueryText(card.player);
  const year = safeQueryText(card.year);
  const brand = safeQueryText(card.brand);
  const type = safeQueryText(card.type);
  const number = safeQueryText(card.number);
  const notes = safeQueryText(card.notes);

  const core = [player, year, brand, number].filter(Boolean).join(" ");

  // 1) Exact catalog description.
  const primary = [
    core,
    type,
    String(card.rookie).toUpperCase() === "Y" ? "rookie" : "",
    "football card"
  ].filter(Boolean).join(" ");

  // 2) Less restrictive. Useful when a site calls "Base" nothing at all,
  // or when the sheet's Type wording differs from the database.
  const broad = [
    core,
    notes,
    "football card"
  ].filter(Boolean).join(" ");

  // 3/4) Plain source-name searches. These are free-tier-safe because they
  // use no site: operator, but strongly surface canonical database images.
  const sportsCardsPro = [
    core,
    notes,
    "SportsCardsPro"
  ].filter(Boolean).join(" ");

  const sportsCardInvestor = [
    core,
    type,
    notes,
    "Sports Card Investor"
  ].filter(Boolean).join(" ");

  return [...new Set(
    [primary, broad, sportsCardsPro, sportsCardInvestor].filter(Boolean)
  )];
}

function pickBest(images, card) {
  const ranked = (images || [])
    .map(result => ({ ...result, _score: scoreResult(result, card) }))
    .filter(result => result.imageUrl || result.thumbnailUrl)
    .sort((a, b) => b._score - a._score);

  const best = ranked[0];
  if (!best) return null;

  // Trusted card databases can sometimes omit "Base", "RC", etc. from the
  // image title even when player/year/set/number are correct. Give those
  // canonical sources a slightly lower acceptance threshold.
  const threshold = isTrustedCardDomain(best.domain) ? 44 : 52;

  if (best._score < threshold) return null;
  return best;
}

async function serperSearch(apiKey, query) {
  const response = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      gl: "us",
      hl: "en",
      num: 10
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper HTTP ${response.status}: ${text.slice(0, 160)}`);
  }

  return response.json();
}

async function resolveCard(apiKey, card) {
  if (!card?.key || !card.player || !card.year || !card.brand || !card.number) {
    return {
      key: card?.key || "",
      imageUrl: "",
      error: "Missing identifying card data."
    };
  }

  const queries = buildQueries(card);
  let best = null;

  // Start exact. Only spend a second search credit if exact search cannot
  // produce a trustworthy match.
  for (const query of queries) {
    const data = await serperSearch(apiKey, query);
    best = pickBest(data.images || [], card);
    if (best) break;
  }

  if (!best) {
    return {
      key: card.key,
      imageUrl: "",
      sourcePage: "",
      source: "",
      matchTitle: ""
    };
  }

  // Prefer the original card image; retain Google's thumbnail as a browser
  // fallback if the source site blocks embedding.
  return {
    key: card.key,
    imageUrl: best.imageUrl || best.thumbnailUrl || "",
    fallbackImageUrl: best.thumbnailUrl || "",
    originalImageUrl: best.imageUrl || "",
    sourcePage: best.link || "",
    source: best.source || best.domain || "",
    domain: best.domain || "",
    matchTitle: best.title || "",
    matchScore: best._score
  };
}

function json(body, status = 200, cacheSeconds = 0) {
  const headers = {
    "content-type": "application/json; charset=utf-8"
  };

  if (cacheSeconds > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
    headers["Netlify-CDN-Cache-Control"] =
      `public, durable, max-age=${cacheSeconds}`;
  } else {
    headers["Cache-Control"] = "no-store";
  }

  return new Response(JSON.stringify(body), { status, headers });
}

export default async (request) => {
  try {
    const apiKey = process.env.SERPER_API_KEY || "";

    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get("health") === "1") {
      if (!apiKey) {
        return json({
          configured: false,
          code: "SERPER_NOT_CONFIGURED",
          error: "SERPER_API_KEY is not available to this Netlify Function."
        }, 503);
      }

      return json({
        configured: true,
        provider: "Serper Google Images"
      });
    }

    if (!apiKey) {
      return json({
        code: "SERPER_NOT_CONFIGURED",
        error: "SERPER_API_KEY is not available to this Netlify Function."
      }, 503);
    }

    if (request.method !== "POST") {
      return json({ error: "Use POST for image batches." }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON request." }, 400);
    }

    const cards = Array.isArray(body.cards)
      ? body.cards.slice(0, MAX_CARDS)
      : [];

    if (!cards.length) {
      return json({ error: "No cards supplied." }, 400);
    }

    const settled = await Promise.allSettled(
      cards.map(card => resolveCard(apiKey, card))
    );

    const results = [];
    const providerErrors = [];

    settled.forEach((item, index) => {
      if (item.status === "fulfilled") {
        results.push(item.value);
      } else {
        const message = item.reason?.message || "Unknown image provider error";
        providerErrors.push(message);
        results.push({
          key: cards[index]?.key || "",
          imageUrl: "",
          error: message
        });
      }
    });

    // A provider-level rejection is not the same as "no card image found".
    // Return a real error status so the browser stops the queue and shows it.
    if (providerErrors.length === cards.length) {
      const first = providerErrors[0] || "Image provider rejected the searches.";
      return json({
        error: first,
        code: /pattern not allowed/i.test(first)
          ? "SERPER_FREE_QUERY_PATTERN"
          : "SERPER_PROVIDER_ERROR",
        providerErrors
      }, 502);
    }

    return json({
      results,
      providerErrors,
      provider: "Serper Google Images"
    }, 200);

  } catch (error) {
    return json({ error: error.message }, 500);
  }
};
