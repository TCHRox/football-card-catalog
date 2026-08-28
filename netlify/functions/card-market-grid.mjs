import { getStore } from "@netlify/blobs";

const SCRAPER_ID = "5e67e7a5-866b-4073-8d41-881feb8b574b";
const SEARCH_URL = `https://api.parse.bot/scraper/${SCRAPER_ID}/search_cards`;
const SUMMARY_STORE = "football-card-market-summary";
const SUMMARY_INDEX_KEY = "__index__";
const GROUP_STORE = "football-card-market-grid-groups";
const GROUP_CACHE_MS = 24 * 60 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
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

function normalizeBrand(value) {
  return norm(value)
    .replace(/\bdonruss optics\b/g, "donruss optic")
    .replace(/\bpanini\b/g, "")
    .trim();
}

function groupKey(card) {
  return `${norm(card.player)}|${norm(card.year)}`;
}

function groupBlobKey(group) {
  return Buffer.from(group, "utf8").toString("base64url");
}

function scoreResult(result, card) {
  const name = norm(result.card_name || "");
  const setName = norm(result.set_name || "");
  const number = norm(result.card_number || "");
  const year = String(result.year || "");
  const combined = `${name} ${setName}`;

  const playerTokens = norm(card.player).split(/\s+/).filter(Boolean);
  if (!playerTokens.length || !playerTokens.every(token => combined.includes(token))) {
    return -100;
  }

  if (year !== String(card.year)) return -100;

  const targetNumber = norm(card.number);
  if (!targetNumber || number !== targetNumber) return -100;

  let score = 80;

  const brandTokens = normalizeBrand(card.brand).split(/\s+/).filter(Boolean);
  if (brandTokens.length && brandTokens.every(token => setName.includes(token))) {
    score += 25;
  } else if (brandTokens.some(token => setName.includes(token))) {
    score += 10;
  } else {
    score -= 20;
  }

  const type = norm(card.type);
  const typeTokens = type
    .split(/\s+/)
    .filter(token => token && !["base", "parallel", "subset"].includes(token));

  if (typeTokens.some(token => combined.includes(token))) score += 8;

  const noteTokens = norm(card.notes)
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .slice(0, 6);

  if (noteTokens.length) {
    if (noteTokens.some(token => combined.includes(token))) score += 12;
    else if (type === "parallel") score -= 20;
  }

  // Do not guess an unnamed parallel merely because player/year/number match.
  if (type === "parallel" && !norm(card.notes)) {
    score -= 30;
  }

  return score;
}

function summaryFromResult(result, existing = {}) {
  const prices = result?.prices || {};

  return {
    ungraded: prices.ungraded ?? existing.ungraded ?? null,
    grade9: prices.grade_9 ?? existing.grade9 ?? null,
    psa10: prices.psa_10 ?? existing.psa10 ?? null,
    changes: existing.changes || {
      ungraded: null,
      grade9: null,
      psa10: null
    },
    source: existing.source === "detail" ? "detail" : "search",
    updatedAt: Date.now()
  };
}

function matchCards(cards, results, summaryIndex) {
  let changed = false;

  for (const card of cards) {
    const ranked = (results || [])
      .map(result => ({ result, score: scoreResult(result, card) }))
      .sort((a,b) => b.score - a.score);

    const best = ranked[0];
    if (!best || best.score < 85) continue;

    summaryIndex[card.key] = summaryFromResult(
      best.result,
      summaryIndex[card.key] || {}
    );
    changed = true;
  }

  return changed;
}

async function searchParse(apiKey, player, year) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", player);
  url.searchParams.set("sport", "football-cards");
  url.searchParams.set("year", year);
  url.searchParams.set("page", "1");

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
    payload = {};
  }

  if (!response.ok) {
    const message =
      payload.error ||
      payload.message ||
      payload.detail ||
      `Parse returned HTTP ${response.status}.`;

    const error = new Error(
      typeof message === "string" ? message : JSON.stringify(message)
    );
    error.status = response.status;
    throw error;
  }

  const data = payload?.data !== undefined ? payload.data : payload;

  return Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data)
      ? data
      : [];
}

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "Use POST." }, 405);
    }

    const body = await request.json().catch(() => ({}));
    const cards = Array.isArray(body.cards)
      ? body.cards.filter(card =>
          card?.key && card?.player && card?.year && card?.brand && card?.number
        ).slice(0, 300)
      : [];

    if (!cards.length) {
      return json({ summaries: {}, remainingGroups: 0 });
    }

    const summaryStore = getStore({
      name: SUMMARY_STORE,
      consistency: "strong"
    });
    const groupStore = getStore({
      name: GROUP_STORE,
      consistency: "strong"
    });

    const summaryIndex =
      await summaryStore.get(SUMMARY_INDEX_KEY, { type: "json" }) || {};

    const grouped = new Map();

    for (const card of cards) {
      if (summaryIndex[card.key]?.source === "detail") continue;

      const key = groupKey(card);
      if (!grouped.has(key)) {
        grouped.set(key, {
          player: card.player,
          year: card.year,
          cards: []
        });
      }
      grouped.get(key).cards.push(card);
    }

    let summaryChanged = false;
    const uncachedGroups = [];

    // First use all persistent player/year search caches without spending credits.
    for (const [key, group] of grouped.entries()) {
      const cached = await groupStore.get(groupBlobKey(key), { type: "json" });

      if (
        cached?.results &&
        Number(cached.fetchedAt || 0) > Date.now() - GROUP_CACHE_MS
      ) {
        if (matchCards(group.cards, cached.results, summaryIndex)) {
          summaryChanged = true;
        }
      } else {
        uncachedGroups.push({ key, ...group });
      }
    }

    // At most ONE new Parse search per request. The browser spaces these calls
    // 20 seconds apart so the free 5-requests/minute allowance is respected.
    const apiKey = process.env.PARSE_API_KEY || "";

    if (apiKey && uncachedGroups.length) {
      const group = uncachedGroups[0];

      try {
        const results = await searchParse(apiKey, group.player, group.year);

        await groupStore.setJSON(groupBlobKey(group.key), {
          results,
          fetchedAt: Date.now()
        });

        if (matchCards(group.cards, results, summaryIndex)) {
          summaryChanged = true;
        }

        uncachedGroups.shift();
      } catch (error) {
        // Don't make the whole catalog fail just because the optional
        // background market-value warmup is temporarily rate-limited.
        if (![429, 401, 403].includes(error.status)) {
          console.warn("Grid market search failed:", error.message);
        }
      }
    }

    if (summaryChanged) {
      await summaryStore.setJSON(SUMMARY_INDEX_KEY, summaryIndex);
    }

    const requested = {};
    for (const card of cards) {
      if (summaryIndex[card.key]) {
        requested[card.key] = summaryIndex[card.key];
      }
    }

    return json({
      summaries: requested,
      remainingGroups: uncachedGroups.length
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
};
