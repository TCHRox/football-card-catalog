import { getStore } from "@netlify/blobs";

const SCRAPER_ID = "5e67e7a5-866b-4073-8d41-881feb8b574b";
const BASE_URL = `https://api.parse.bot/scraper/${SCRAPER_ID}`;
const CACHE_STORE = "football-card-market-cache";
const MARKET_CACHE_MS = 12 * 60 * 60 * 1000;
const MATCH_CACHE_MS = 180 * 24 * 60 * 60 * 1000;

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

function norm(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cardCacheKey(card) {
  const raw = [
    card.player,
    card.year,
    card.brand,
    card.type,
    card.number,
    card.notes
  ].map(norm).join("|");

  return Buffer.from(raw, "utf8").toString("base64url");
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && payload.data !== undefined) {
    return payload.data;
  }
  return payload;
}

async function parseGet(apiKey, endpoint, params = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      "X-API-Key": apiKey,
      "Accept": "application/json"
    }
  });

  const text = await response.text();
  let payload = {};

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    const message =
      payload?.error ||
      payload?.message ||
      payload?.detail ||
      `Parse returned HTTP ${response.status}.`;

    const error = new Error(
      typeof message === "string" ? message : JSON.stringify(message)
    );
    error.status = response.status;
    throw error;
  }

  return unwrap(payload);
}

function normalizeBrand(value) {
  return norm(value)
    .replace(/\bdonruss optics\b/g, "donruss optic")
    .replace(/\bpanini\b/g, "")
    .trim();
}

function scoreSearchResult(result, card) {
  const name = norm(result.card_name || result.name || "");
  const setName = norm(result.set_name || result.set || "");
  const number = norm(result.card_number || result.number || "");
  const year = String(result.year || "");
  const sport = norm(result.sport || "");
  const combined = `${name} ${setName} ${number}`;

  let score = 0;

  const playerTokens = norm(card.player).split(/\s+/).filter(Boolean);
  if (playerTokens.length && playerTokens.every(t => combined.includes(t))) {
    score += 40;
  } else {
    return -100;
  }

  if (card.year && (year === String(card.year) || setName.includes(norm(card.year)))) {
    score += 22;
  } else if (card.year) {
    score -= 25;
  }

  const targetNumber = norm(card.number);
  if (targetNumber && number === targetNumber) {
    score += 35;
  } else if (targetNumber && combined.includes(targetNumber)) {
    score += 15;
  } else if (targetNumber) {
    score -= 30;
  }

  const brandTokens = normalizeBrand(card.brand).split(/\s+/).filter(Boolean);
  if (brandTokens.length && brandTokens.every(t => setName.includes(t))) {
    score += 22;
  } else if (brandTokens.some(t => setName.includes(t))) {
    score += 8;
  }

  const typeTokens = norm(card.type)
    .split(/\s+/)
    .filter(t => t && !["base", "parallel", "subset"].includes(t));

  if (typeTokens.length && typeTokens.some(t => setName.includes(t) || name.includes(t))) {
    score += 8;
  }

  const noteTokens = norm(card.notes)
    .split(/\s+/)
    .filter(t => t.length >= 3)
    .slice(0, 6);

  if (noteTokens.length && noteTokens.some(t => combined.includes(t))) {
    score += 8;
  }

  if (sport && !sport.includes("football")) score -= 25;

  return score;
}

async function findCardId(apiKey, card) {
  const query = [
    card.player,
    card.brand,
    card.type && !/^base$/i.test(card.type) ? card.type : "",
    card.number ? `#${card.number}` : ""
  ].filter(Boolean).join(" ");

  const search = await parseGet(apiKey, "search_cards", {
    query,
    sport: "football-cards",
    year: card.year,
    set: card.brand,
    page: 1
  });

  const results = Array.isArray(search?.results)
    ? search.results
    : Array.isArray(search)
      ? search
      : [];

  const ranked = results
    .map(result => ({
      result,
      score: scoreSearchResult(result, card)
    }))
    .sort((a,b) => b.score - a.score);

  const best = ranked[0];

  if (!best || best.score < 75 || !best.result.card_id) {
    return null;
  }

  return {
    cardId: best.result.card_id,
    score: best.score,
    result: best.result
  };
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = String(value)
    .replace(/[$,\s]/g, "")
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function priceLabel(key) {
  const known = {
    ungraded: "Ungraded",
    grade_1: "Grade 1",
    grade_2: "Grade 2",
    grade_3: "Grade 3",
    grade_4: "Grade 4",
    grade_5: "Grade 5",
    grade_6: "Grade 6",
    grade_7: "Grade 7",
    grade_8: "Grade 8",
    grade_9: "Grade 9",
    grade_9_5: "Grade 9.5",
    tag_10: "TAG 10",
    ace_10: "ACE 10",
    sgc_10: "SGC 10",
    cgc_10: "CGC 10",
    psa_10: "PSA 10",
    bgs_10: "BGS 10",
    bgs_10_black: "BGS 10 Black",
    cgc_10_pristine: "CGC 10 Pristine"
  };

  if (known[key]) return known[key];

  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function findObjectByKey(root, targetKeys, depth = 0) {
  if (!root || typeof root !== "object" || depth > 5) return null;

  for (const [key, value] of Object.entries(root)) {
    if (targetKeys.includes(key) && value && typeof value === "object") {
      return value;
    }
  }

  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      const found = findObjectByKey(value, targetKeys, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function normalizePrices(detail) {
  const obj =
    findObjectByKey(detail, ["prices", "price_guide", "grade_prices"]) || {};

  const prices = [];

  for (const [key, value] of Object.entries(obj)) {
    const numeric = numberValue(
      value && typeof value === "object"
        ? value.price ?? value.value ?? value.current_price
        : value
    );

    // Keep known grades even when null only if the API actually supplied the key.
    if (numeric === null && value !== null) continue;

    prices.push({
      key,
      label: priceLabel(key),
      value: numeric
    });
  }

  return prices;
}

function normalizeTrendPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const date = String(point[0] || "");
    const price = numberValue(point[1]);
    return date && price !== null
      ? { date, numericPrice: price, price }
      : null;
  }

  if (!point || typeof point !== "object") return null;

  const date =
    point.date ||
    point.month ||
    point.timestamp ||
    point.time ||
    point.x ||
    "";

  const rawPrice =
    point.price ??
    point.value ??
    point.market_price ??
    point.y;

  const price = numberValue(rawPrice);

  if (!date || price === null) return null;

  let normalizedDate = String(date);

  if (/^\d{10,13}$/.test(normalizedDate)) {
    const n = Number(normalizedDate);
    const ms = normalizedDate.length === 10 ? n * 1000 : n;
    normalizedDate = new Date(ms).toISOString().slice(0, 10);
  }

  return {
    date: normalizedDate,
    numericPrice: price,
    price
  };
}

function normalizeTrends(detail) {
  const trendObj =
    findObjectByKey(detail, ["price_trend", "price_trends", "trends"]) || {};

  const normalized = {};

  for (const [key, value] of Object.entries(trendObj)) {
    if (!Array.isArray(value)) continue;

    const points = value
      .map(normalizeTrendPoint)
      .filter(Boolean)
      .sort((a,b) => Date.parse(a.date) - Date.parse(b.date));

    if (points.length) normalized[key] = points;
  }

  const preferredKeys = [
    "ungraded",
    "used",
    "raw",
    "grade_9",
    "psa_10"
  ];

  let primary = [];

  for (const key of preferredKeys) {
    if (normalized[key]?.length) {
      primary = normalized[key];
      break;
    }
  }

  if (!primary.length) {
    primary = Object.values(normalized)
      .find(points => Array.isArray(points) && points.length) || [];
  }

  return {
    all: normalized,
    primary
  };
}

function looksLikeSale(obj) {
  if (!obj || typeof obj !== "object") return false;

  const hasDate = Boolean(obj.date || obj.sale_date || obj.sold_date);
  const hasPrice =
    obj.price !== undefined ||
    obj.sale_price !== undefined ||
    obj.numericPrice !== undefined;

  const hasDescription =
    Boolean(obj.title || obj.listing_title || obj.marketplace || obj.source);

  return hasDate && hasPrice && hasDescription;
}

function findSalesArrays(root, depth = 0, found = []) {
  if (!root || typeof root !== "object" || depth > 6) return found;

  if (Array.isArray(root)) {
    if (root.length && root.some(looksLikeSale)) {
      found.push(root);
      return found;
    }

    for (const item of root) {
      findSalesArrays(item, depth + 1, found);
    }
    return found;
  }

  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      findSalesArrays(value, depth + 1, found);
    }
  }

  return found;
}

function normalizeSale(sale) {
  const price = numberValue(
    sale.price ??
    sale.sale_price ??
    sale.numericPrice
  );

  const date =
    sale.date ||
    sale.sale_date ||
    sale.sold_date ||
    "";

  if (!date || price === null) return null;

  return {
    date: String(date),
    title: String(
      sale.title ||
      sale.listing_title ||
      "Completed sale"
    ),
    numericPrice: price,
    price,
    marketplace: String(
      sale.marketplace ||
      sale.source ||
      ""
    ),
    url: String(
      sale.url ||
      sale.listing_url ||
      sale.link ||
      ""
    )
  };
}

function extractSales(root) {
  const arrays = findSalesArrays(root);

  const merged = arrays
    .flat()
    .map(normalizeSale)
    .filter(Boolean);

  const seen = new Set();

  return merged
    .filter(sale => {
      const key = `${sale.date}|${sale.title}|${sale.numericPrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a,b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 30);
}

async function getUngradedSales(apiKey, cardId) {
  try {
    const history = await parseGet(apiKey, "get_price_history", {
      card_id: cardId,
      grade: "ungraded"
    });

    return extractSales(history);
  } catch (error) {
    // The modal can still be useful without listings, so don't fail the entire
    // market request if only the history endpoint has trouble.
    return [];
  }
}

function sportsCardsProUrl(cardId) {
  return `https://www.sportscardspro.com/game/${cardId}`;
}

export default async (request) => {
  try {
    const apiKey = process.env.PARSE_API_KEY || "";

    if (!apiKey) {
      return json({
        found: false,
        code: "PARSE_API_NOT_CONFIGURED",
        message: "PARSE_API_KEY is not configured in Netlify."
      }, 503);
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
      return json({
        found: false,
        message: "Not enough identifying card data is available for market lookup."
      }, 200, 1800);
    }

    const s = getStore({
      name: CACHE_STORE,
      consistency: "strong"
    });

    const cacheKey = cardCacheKey(card);
    const stored = await s.get(cacheKey, { type: "json" });

    if (
      stored?.marketData &&
      Number(stored.marketFetchedAt || 0) > Date.now() - MARKET_CACHE_MS
    ) {
      return json(stored.marketData, 200, 3600);
    }

    let match = null;

    if (
      stored?.cardId &&
      Number(stored.matchFetchedAt || 0) > Date.now() - MATCH_CACHE_MS
    ) {
      match = {
        cardId: stored.cardId,
        score: stored.matchScore || 0,
        result: stored.matchResult || {}
      };
    } else {
      match = await findCardId(apiKey, card);

      if (!match) {
        const miss = {
          ...(stored || {}),
          marketData: {
            found: false,
            message: "No sufficiently confident SportsCardsPro match was found for this card."
          },
          marketFetchedAt: Date.now()
        };

        await s.setJSON(cacheKey, miss);
        return json(miss.marketData, 200, 3600);
      }
    }

    const detail = await parseGet(apiKey, "get_card", {
      card_id: match.cardId
    });

    const prices = normalizePrices(detail);
    const trends = normalizeTrends(detail);
    let sales = extractSales(detail);

    // get_card often includes recent ungraded sales. Only spend the additional
    // Parse credits when that data isn't present.
    if (!sales.length) {
      sales = await getUngradedSales(apiKey, match.cardId);
    }

    const marketData = {
      found: true,
      source: "SportsCardsPro via Parse",
      sourceUrl: sportsCardsProUrl(match.cardId),
      cardId: match.cardId,
      matchScore: match.score,
      cardName:
        detail?.card_name ||
        detail?.name ||
        match.result?.card_name ||
        "",
      setName:
        detail?.set_name ||
        match.result?.set_name ||
        "",
      cardNumber:
        detail?.card_number ||
        match.result?.card_number ||
        card.number,
      imageUrl:
        detail?.image_url ||
        match.result?.image_url ||
        "",
      prices,
      trend: trends.primary,
      trends: trends.all,
      sales,
      fetchedAt: new Date().toISOString()
    };

    await s.setJSON(cacheKey, {
      ...(stored || {}),
      cardId: match.cardId,
      matchScore: match.score,
      matchResult: match.result,
      matchFetchedAt: stored?.matchFetchedAt || Date.now(),
      marketData,
      marketFetchedAt: Date.now()
    });

    return json(marketData, 200, 3600);

  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return json({
        found: false,
        code: "PARSE_API_KEY_REJECTED",
        message: "Parse rejected PARSE_API_KEY. Check the key in Netlify and redeploy."
      }, 401);
    }

    if (error.status === 429) {
      return json({
        found: false,
        code: "PARSE_RATE_LIMIT",
        message: "The Parse rate limit was reached. Wait a moment and open the card again."
      }, 429);
    }

    return json({
      found: false,
      error: error.message
    }, 500);
  }
};
