import { getStore } from "@netlify/blobs";

const SCRAPER_ID = "5e67e7a5-866b-4073-8d41-881feb8b574b";
const BASE_URL = `https://api.parse.bot/scraper/${SCRAPER_ID}`;
const SERPER_SEARCH = "https://google.serper.dev/search";
const CACHE_STORE = "football-card-market-cache";
const MARKET_CACHE_MS = 12 * 60 * 60 * 1000;
const MATCH_CACHE_MS = 180 * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 19;

function json(body, status = 200, cacheSeconds = 0) {
  const headers = { "content-type": "application/json; charset=utf-8" };
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
    "v19",
    card.player, card.year, card.brand, card.type, card.number, card.notes
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
    headers: { "X-API-Key": apiKey, "Accept": "application/json" }
  });

  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); }
  catch { payload = { raw: text.slice(0, 500) }; }

  if (!response.ok) {
    const message = payload?.error || payload?.message || payload?.detail ||
      `Parse returned HTTP ${response.status}.`;
    const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }

  return unwrap(payload);
}

function extractSportsCardsProCardId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/sportscardspro\.com$/i.test(url.hostname.replace(/^www\./, ""))) return "";
    const marker = "/game/";
    const i = url.pathname.indexOf(marker);
    if (i < 0) return "";
    return decodeURIComponent(url.pathname.slice(i + marker.length)).replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
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

  const playerTokens = norm(card.player).split(/\s+/).filter(Boolean);
  if (!playerTokens.length || !playerTokens.every(t => combined.includes(t))) return -100;

  let score = 40;

  if (card.year && (year === String(card.year) || setName.includes(norm(card.year)))) score += 24;
  else if (card.year) score -= 30;

  const targetNumber = norm(card.number);
  if (targetNumber && number === targetNumber) score += 40;
  else if (targetNumber && combined.includes(targetNumber)) score += 18;
  else if (targetNumber) score -= 35;

  const brandTokens = normalizeBrand(card.brand).split(/\s+/).filter(Boolean);
  if (brandTokens.length && brandTokens.every(t => setName.includes(t))) score += 24;
  else if (brandTokens.some(t => setName.includes(t))) score += 10;

  const typeTokens = norm(card.type)
    .split(/\s+/)
    .filter(t => t && !["base", "parallel", "subset"].includes(t));
  if (typeTokens.some(t => setName.includes(t) || name.includes(t))) score += 8;

  const noteTokens = norm(card.notes).split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
  if (noteTokens.some(t => combined.includes(t))) score += 8;

  if (sport && !sport.includes("football")) score -= 30;

  return score;
}

function resultsArray(search) {
  return Array.isArray(search?.results)
    ? search.results
    : Array.isArray(search)
      ? search
      : [];
}

function bestResult(results, card) {
  return results
    .map(result => ({ result, score: scoreSearchResult(result, card) }))
    .sort((a,b) => b.score - a.score)[0] || null;
}

async function findViaSerper(apiKey, card) {
  if (!apiKey) return null;

  const q = [
    card.player,
    card.year,
    card.brand,
    card.type && !/^base$/i.test(card.type) ? card.type : "",
    card.number,
    "SportsCardsPro football card"
  ].filter(Boolean).join(" ");

  const response = await fetch(SERPER_SEARCH, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q, gl: "us", hl: "en", num: 10 })
  });

  if (!response.ok) return null;

  const data = await response.json();

  const candidates = (data.organic || [])
    .map(item => {
      const cardId = extractSportsCardsProCardId(item.link || "");
      if (!cardId) return null;

      // Convert URL slug into a pseudo search result so the same strict scorer
      // can validate year/player/card-number consistency.
      const slugText = cardId.replace(/[\/_-]+/g, " ");
      return {
        item,
        cardId,
        pseudo: {
          card_id: cardId,
          card_name: `${item.title || ""} ${slugText}`,
          card_number: card.number,
          set_name: `${item.title || ""} ${slugText}`,
          year: card.year,
          sport: "football"
        }
      };
    })
    .filter(Boolean)
    .map(candidate => ({
      ...candidate,
      score: scoreSearchResult(candidate.pseudo, card)
    }))
    .sort((a,b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < 85) return null;

  return {
    cardId: best.cardId,
    score: best.score,
    result: best.pseudo,
    method: "serper"
  };
}

async function findViaParse(apiKey, card) {
  // First try: exact identity fields, but avoid over-constraining with "type".
  const first = await parseGet(apiKey, "search_cards", {
    query: `${card.player} #${card.number}`,
    sport: "football-cards",
    year: card.year,
    set: card.brand,
    page: 1
  });

  let best = bestResult(resultsArray(first), card);
  if (best?.score >= 85 && best.result.card_id) {
    return { cardId: best.result.card_id, score: best.score, result: best.result, method: "parse-exact" };
  }

  // Second pass only when needed: remove the set filter because names such as
  // "Score" vs "Panini Score" and "Optics" vs "Optic" otherwise cause misses.
  const second = await parseGet(apiKey, "search_cards", {
    query: `${card.player} ${card.year} #${card.number}`,
    sport: "football-cards",
    page: 1
  });

  const combined = [...resultsArray(first), ...resultsArray(second)];
  best = bestResult(combined, card);

  if (!best || best.score < 85 || !best.result.card_id) {
    return {
      match: null,
      topCandidate: best?.result || null,
      topScore: best?.score || 0
    };
  }

  return {
    cardId: best.result.card_id,
    score: best.score,
    result: best.result,
    method: "parse-broad"
  };
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,\s]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function priceLabel(key) {
  const known = {
    ungraded:"Ungraded", grade_1:"Grade 1", grade_2:"Grade 2", grade_3:"Grade 3",
    grade_4:"Grade 4", grade_5:"Grade 5", grade_6:"Grade 6", grade_7:"Grade 7",
    grade_8:"Grade 8", grade_9:"Grade 9", grade_9_5:"Grade 9.5", tag_10:"TAG 10",
    ace_10:"ACE 10", sgc_10:"SGC 10", cgc_10:"CGC 10", psa_10:"PSA 10",
    bgs_10:"BGS 10", bgs_10_black:"BGS 10 Black", cgc_10_pristine:"CGC 10 Pristine"
  };
  return known[key] || String(key).replace(/_/g," ").replace(/\b\w/g,ch=>ch.toUpperCase());
}

function findObjectByKey(root, targetKeys, depth = 0) {
  if (!root || typeof root !== "object" || depth > 5) return null;
  for (const [key,value] of Object.entries(root)) {
    if (targetKeys.includes(key) && value && typeof value === "object") return value;
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
  const obj = findObjectByKey(detail, ["prices","price_guide","grade_prices"]) || {};
  const prices = [];
  for (const [key,value] of Object.entries(obj)) {
    const numeric = numberValue(
      value && typeof value === "object"
        ? value.price ?? value.value ?? value.current_price
        : value
    );
    if (numeric === null && value !== null) continue;
    prices.push({ key, label: priceLabel(key), value: numeric });
  }
  return prices;
}

function normalizeTrendPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const price = numberValue(point[1]);
    return point[0] && price !== null
      ? { date:String(point[0]), numericPrice:price, price }
      : null;
  }
  if (!point || typeof point !== "object") return null;
  let date = point.date || point.month || point.timestamp || point.time || point.x || "";
  const price = numberValue(point.price ?? point.value ?? point.market_price ?? point.y);
  if (!date || price === null) return null;
  date = String(date);
  if (/^\d{10,13}$/.test(date)) {
    const n = Number(date);
    date = new Date(date.length === 10 ? n*1000 : n).toISOString().slice(0,10);
  }
  return { date, numericPrice:price, price };
}

function normalizeTrends(detail) {
  const trendObj = findObjectByKey(detail, ["price_trend","price_trends","trends"]) || {};
  const normalized = {};
  for (const [key,value] of Object.entries(trendObj)) {
    if (!Array.isArray(value)) continue;
    const points = value.map(normalizeTrendPoint).filter(Boolean)
      .sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
    if (points.length) normalized[key] = points;
  }
  const primary =
    normalized.ungraded ||
    normalized.used ||
    normalized.raw ||
    Object.values(normalized).find(points => points?.length) ||
    [];
  return { all: normalized, primary };
}

function looksLikeSale(obj) {
  if (!obj || typeof obj !== "object") return false;
  const hasDate = Boolean(obj.date || obj.sale_date || obj.sold_date);
  const hasPrice = obj.price !== undefined || obj.sale_price !== undefined || obj.numericPrice !== undefined;
  const hasDescription = Boolean(obj.title || obj.listing_title || obj.marketplace || obj.source);
  return hasDate && hasPrice && hasDescription;
}

function findSalesArrays(root, depth = 0, found = []) {
  if (!root || typeof root !== "object" || depth > 6) return found;
  if (Array.isArray(root)) {
    if (root.length && root.some(looksLikeSale)) {
      found.push(root);
      return found;
    }
    for (const item of root) findSalesArrays(item, depth+1, found);
    return found;
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") findSalesArrays(value, depth+1, found);
  }
  return found;
}

function normalizeSale(sale) {
  const price = numberValue(sale.price ?? sale.sale_price ?? sale.numericPrice);
  const date = sale.date || sale.sale_date || sale.sold_date || "";
  if (!date || price === null) return null;

  // The current Parse SportsCardsPro contract promises date/title/price/marketplace,
  // but this also captures a URL automatically if Parse adds one later.
  const url =
    sale.url ||
    sale.listing_url ||
    sale.listingUrl ||
    sale.sale_url ||
    sale.saleUrl ||
    sale.ebay_url ||
    sale.item_url ||
    sale.href ||
    sale.link ||
    "";

  return {
    date:String(date),
    title:String(sale.title || sale.listing_title || "Completed sale"),
    numericPrice:price,
    price,
    marketplace:String(sale.marketplace || sale.source || ""),
    url:String(url || "")
  };
}

function extractSales(root) {
  const arrays = findSalesArrays(root);
  const seen = new Set();
  return arrays.flat().map(normalizeSale).filter(Boolean)
    .filter(sale => {
      const key = `${sale.date}|${sale.title}|${sale.numericPrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}


function sportsCardsProUrl(cardId) {
  return `https://www.sportscardspro.com/game/${cardId}`;
}

export default async (request) => {
  try {
    const parseKey = process.env.PARSE_API_KEY || "";
    const serperKey = process.env.SERPER_API_KEY || "";

    if (!parseKey) {
      return json({
        found:false,
        code:"PARSE_API_NOT_CONFIGURED",
        message:"PARSE_API_KEY is not configured in Netlify."
      },503);
    }

    const url = new URL(request.url);
    const card = {
      player:url.searchParams.get("player") || "",
      year:url.searchParams.get("year") || "",
      brand:url.searchParams.get("brand") || "",
      type:url.searchParams.get("type") || "",
      number:url.searchParams.get("number") || "",
      rookie:url.searchParams.get("rookie") || "",
      notes:url.searchParams.get("notes") || "",
      preferredUrl:url.searchParams.get("preferredUrl") || ""
    };

    if (!card.player || !card.year || !card.brand || !card.number) {
      return json({found:false,message:"Not enough identifying card data is available for market lookup."},200,1800);
    }

    const s = getStore({name:CACHE_STORE, consistency:"strong"});
    const cacheKey = cardCacheKey(card);
    const stored = await s.get(cacheKey,{type:"json"});

    if (
      stored?.schemaVersion === SCHEMA_VERSION &&
      stored?.marketData &&
      Number(stored.marketFetchedAt || 0) > Date.now() - MARKET_CACHE_MS
    ) {
      return json(stored.marketData,200,3600);
    }

    let match = null;

    if (
      stored?.schemaVersion === SCHEMA_VERSION &&
      stored?.cardId &&
      Number(stored.matchFetchedAt || 0) > Date.now() - MATCH_CACHE_MS
    ) {
      match = {
        cardId:stored.cardId,
        score:stored.matchScore || 0,
        result:stored.matchResult || {},
        method:stored.matchMethod || "cache"
      };
    }

    // Fastest path: reuse a SportsCardsPro URL already found by the image engine.
    if (!match && card.preferredUrl) {
      const cardId = extractSportsCardsProCardId(card.preferredUrl);
      if (cardId) {
        match = {
          cardId,
          score:100,
          result:{card_id:cardId},
          method:"image-source"
        };
      }
    }

    // Second-fastest path: Serper is much quicker than a browser-backed Parse search.
    if (!match) {
      match = await findViaSerper(serperKey, card);
    }

    // Final discovery fallback: Parse search, now with a broader second pass.
    let parseDiagnostic = null;
    if (!match) {
      const found = await findViaParse(parseKey, card);
      if (found?.cardId) match = found;
      else parseDiagnostic = found;
    }

    if (!match) {
      const candidate = parseDiagnostic?.topCandidate || null;
      const message = candidate
        ? `No exact match passed validation. Closest candidate was ${candidate.card_name || "another card"} (${candidate.set_name || "unknown set"}, #${candidate.card_number || "?"}). Check the year, set, type, and card number in the Sheet.`
        : "No sufficiently confident SportsCardsPro match was found for this card.";

      const missData = {
        found:false,
        message,
        closestCandidate:candidate
      };

      await s.setJSON(cacheKey,{
        schemaVersion:SCHEMA_VERSION,
        marketData:missData,
        marketFetchedAt:Date.now()
      });

      return json(missData,200,1800);
    }

    // Primary market call only. Recent sales are loaded asynchronously by a
    // separate endpoint so they do not hold up the chart and grade values.
    const detail = await parseGet(parseKey,"get_card",{card_id:match.cardId});

    const prices = normalizePrices(detail);
    const trends = normalizeTrends(detail);
    const embeddedSales = extractSales(detail)
      .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date))
      .slice(0,30);

    const marketData = {
      found:true,
      source:"SportsCardsPro via Parse",
      sourceUrl:sportsCardsProUrl(match.cardId),
      cardId:match.cardId,
      matchScore:match.score,
      matchMethod:match.method,
      cardName:detail?.card_name || detail?.name || match.result?.card_name || "",
      setName:detail?.set_name || match.result?.set_name || "",
      cardNumber:detail?.card_number || match.result?.card_number || card.number,
      imageUrl:detail?.image_url || match.result?.image_url || "",
      prices,
      trend:trends.primary,
      trends:trends.all,
      sales:embeddedSales,
      fetchedAt:new Date().toISOString()
    };

    await s.setJSON(cacheKey,{
      schemaVersion:SCHEMA_VERSION,
      cardId:match.cardId,
      matchScore:match.score,
      matchResult:match.result,
      matchMethod:match.method,
      matchFetchedAt:Date.now(),
      marketData,
      marketFetchedAt:Date.now()
    });

    return json(marketData,200,3600);

  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return json({
        found:false,
        code:"PARSE_API_KEY_REJECTED",
        message:"Parse rejected PARSE_API_KEY. Check the key in Netlify and redeploy."
      },401);
    }
    if (error.status === 429) {
      return json({
        found:false,
        code:"PARSE_RATE_LIMIT",
        message:"Parse's current rate limit was reached. Wait about a minute and try this card again."
      },429);
    }
    return json({found:false,error:error.message},500);
  }
};
