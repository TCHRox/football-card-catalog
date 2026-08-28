import { getStore } from "@netlify/blobs";

export const SHEET_ID = "1ZelpNWlXQHIzmDCVSDv1TMYEuh-eua6SKUtsESqlmeI";
export const SHEET_GID = "1796597612";

export const MARKET_STORE = "football-card-cardsight-market";
export const MARKET_INDEX_KEY = "__market_index__";
export const MATCH_INDEX_KEY = "__match_index__";
export const MARKET_STATUS_KEY = "__status__";

const API_BASE = "https://api.cardsight.ai";
const MIN_API_INTERVAL_MS = 350;
let lastApiRequestAt = 0;
let apiCallsThisRun = 0;

export function resetApiCallStats() {
  apiCallsThisRun = 0;
  lastApiRequestAt = 0;
}

export function getApiCallStats() {
  return {
    calls: apiCallsThisRun
  };
}

async function waitForApiSlot() {
  const elapsed = Date.now() - lastApiRequestAt;
  const wait = Math.max(0, MIN_API_INTERVAL_MS - elapsed);

  if (wait) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

export function norm(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ");
}

function fuzzyNorm(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cardKey(card) {
  return [
    card.year,
    card.brand,
    card.player,
    card.number,
    card.type,
    String(card.rookie).toUpperCase() === "Y" ? "rookie" : ""
  ].map(norm).join("|");
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

export async function loadSheetCards() {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!response.ok) {
    throw new Error(`Google Sheets returned HTTP ${response.status}.`);
  }

  const csv = await response.text();
  const matrix = parseCSV(csv)
    .filter(row => row.some(cell => String(cell || "").trim() !== ""));

  if (matrix.length < 2) return [];

  let previousFirst = "";
  let previousLast = "";

  return matrix.slice(1).map((cols, index) => {
    const first = String(cols[0] || "").trim();
    const last = String(cols[1] || "").trim();

    if (first) previousFirst = first;
    if (last) previousLast = last;

    const card = {
      rowNumber: index + 2,
      player: [previousFirst, previousLast].filter(Boolean).join(" ").trim(),
      year: String(cols[2] || "").trim(),
      rookie: String(cols[3] || "").trim(),
      brand: String(cols[4] || "").trim(),
      type: String(cols[5] || "").trim(),
      number: String(cols[6] || "").trim(),
      quantity: Math.max(1, parseInt(String(cols[7] || "1"), 10) || 1),
      notes: String(cols[14] || "").trim()
    };

    card.key = cardKey(card);
    return card;
  }).filter(card =>
    card.player &&
    card.year &&
    card.brand &&
    card.number
  );
}

export function marketStore() {
  return getStore({
    name: MARKET_STORE,
    consistency: "strong"
  });
}

export async function loadMarketState() {
  const store = marketStore();

  const [summaries, matches, status] = await Promise.all([
    store.get(MARKET_INDEX_KEY, { type: "json" }),
    store.get(MATCH_INDEX_KEY, { type: "json" }),
    store.get(MARKET_STATUS_KEY, { type: "json" })
  ]);

  return {
    store,
    summaries: summaries || {},
    matches: matches || {},
    status: status || {}
  };
}

export async function saveStatus(store, status) {
  await store.setJSON(MARKET_STATUS_KEY, status);
}

function apiErrorMessage(payload, response) {
  return (
    payload?.detail ||
    payload?.error ||
    payload?.message ||
    `CardSight returned HTTP ${response.status}.`
  );
}

export async function cardSightRequest(apiKey, path, options = {}) {
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await waitForApiSlot();

    lastApiRequestAt = Date.now();
    apiCallsThisRun += 1;

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let payload = {};

    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }

    if (response.ok) {
      return payload;
    }

    const error = new Error(apiErrorMessage(payload, response));
    error.status = response.status;

    if (response.status === 429 && attempt < maxAttempts - 1) {
      const retryAfterHeader = Number(response.headers.get("retry-after") || 0);
      const retryMs = retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(8000, 1200 * (2 ** attempt));

      await new Promise(resolve => setTimeout(resolve, retryMs));
      continue;
    }

    throw error;
  }

  throw new Error("CardSight request failed after retries.");
}
function unwrap(payload) {
  return payload?.data !== undefined ? payload.data : payload;
}

function cardsArray(payload) {
  const data = unwrap(payload);

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cards)) return data.cards;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.items)) return data.items;

  return [];
}

function totalCount(payload) {
  const data = unwrap(payload);
  return Number(
    data?.total_count ??
    data?.totalCount ??
    data?.meta?.total ??
    data?.meta?.total_count ??
    cardsArray(payload).length
  ) || 0;
}

export async function fetchCandidateCards(apiKey, player, year) {
  const all = [];
  let skip = 0;
  const take = 100;
  const maxPages = 3;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      year: String(year),
      name: String(player),
      take: String(take),
      skip: String(skip)
    });

    const payload = await cardSightRequest(
      apiKey,
      `/v1/catalog/cards?${params.toString()}`
    );

    const pageCards = cardsArray(payload);
    all.push(...pageCards);

    const total = totalCount(payload);
    skip += pageCards.length;

    if (
      pageCards.length < take ||
      !pageCards.length ||
      (total && skip >= total)
    ) {
      break;
    }
  }

  return all;
}

function candidateName(card) {
  return String(card?.name || card?.playerName || card?.player_name || "");
}

function candidateNumber(card) {
  return String(
    card?.number ??
    card?.cardNumber ??
    card?.card_number ??
    ""
  );
}

function candidateYear(card) {
  return String(
    card?.year ??
    card?.releaseYear ??
    card?.release_year ??
    card?.set?.year ??
    card?.release?.year ??
    ""
  );
}

function candidateId(card) {
  return String(card?.id || card?.cardId || card?.card_id || "");
}

function candidateContext(card) {
  return fuzzyNorm([
    card?.manufacturer,
    card?.manufacturerName,
    card?.manufacturer_name,
    card?.releaseName,
    card?.release_name,
    card?.release?.name,
    card?.setName,
    card?.set_name,
    card?.set?.name,
    card?.name
  ].filter(Boolean).join(" "));
}

function normalizedBrand(value) {
  return fuzzyNorm(value)
    .replace(/\bdonruss optics\b/g, "donruss optic")
    .replace(/\btopps chrome\b/g, "topps chrome")
    .replace(/\bpanini\b/g, "")
    .trim();
}

function genericType(value) {
  const type = fuzzyNorm(value);
  return ["", "base", "base set", "parallel", "subset", "insert"].includes(type);
}

function candidateParallels(card) {
  const parallels =
    card?.parallels ||
    card?.parallelVariants ||
    card?.parallel_variants ||
    [];

  return Array.isArray(parallels) ? parallels : [];
}

function matchParallel(card, row) {
  const type = fuzzyNorm(row.type);
  const descriptor = String(
    row.notes ||
    (!genericType(row.type) ? row.type : "")
  ).trim();

  if (type !== "parallel" && !descriptor) {
    return { parallelId: null, parallelName: "" };
  }

  if (!descriptor) {
    return null;
  }

  const target = fuzzyNorm(descriptor);
  const targetTokens = target.split(/\s+/).filter(Boolean);

  const ranked = candidateParallels(card)
    .map(parallel => {
      const name = fuzzyNorm(
        parallel?.name ||
        parallel?.parallelName ||
        parallel?.parallel_name ||
        ""
      );

      let score = 0;
      if (name === target) score += 100;
      if (targetTokens.length && targetTokens.every(token => name.includes(token))) {
        score += 50;
      }
      if (name.includes(target) || target.includes(name)) score += 20;

      return { parallel, score };
    })
    .sort((a,b) => b.score - a.score);

  const best = ranked[0];

  if (!best || best.score < 40) return null;

  return {
    parallelId: String(
      best.parallel?.id ||
      best.parallel?.parallelId ||
      best.parallel?.parallel_id ||
      ""
    ) || null,
    parallelName: String(
      best.parallel?.name ||
      best.parallel?.parallelName ||
      best.parallel?.parallel_name ||
      descriptor
    )
  };
}

function catalogPrices(card) {
  const prices = card?.prices || {};

  const value = (...keys) => {
    for (const key of keys) {
      const raw = prices?.[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const n = Number(String(raw).replace(/[$,\s]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  return {
    ungraded: value("raw", "ungraded"),
    psa9: value("psa_9", "psa9", "grade_9"),
    psa10: value("psa_10", "psa10")
  };
}

export function buildSummaryFromCatalogMatch(match, existing = {}) {
  const prices = match?.catalogPrices || {};

  const hasAny =
    Number.isFinite(Number(prices.ungraded)) ||
    Number.isFinite(Number(prices.psa9)) ||
    Number.isFinite(Number(prices.psa10));

  if (!hasAny) return existing || {};

  return {
    ...existing,
    ungraded: Number.isFinite(Number(prices.ungraded))
      ? Number(prices.ungraded)
      : existing.ungraded ?? null,
    psa9: Number.isFinite(Number(prices.psa9))
      ? Number(prices.psa9)
      : existing.psa9 ?? existing.grade9 ?? null,
    grade9: Number.isFinite(Number(prices.psa9))
      ? Number(prices.psa9)
      : existing.grade9 ?? existing.psa9 ?? null,
    psa10: Number.isFinite(Number(prices.psa10))
      ? Number(prices.psa10)
      : existing.psa10 ?? null,
    changes: existing.changes || {
      ungraded: null,
      psa9: null,
      grade9: null,
      psa10: null
    },
    source: existing.source || "CardSight catalog",
    updatedAt: Date.now()
  };
}

export function matchRowToCandidate(row, candidates) {
  const playerTokens = fuzzyNorm(row.player).split(/\s+/).filter(Boolean);
  const brandTokens = normalizedBrand(row.brand).split(/\s+/).filter(Boolean);
  const rowNumber = fuzzyNorm(row.number);
  const rowYear = String(row.year);

  const ranked = candidates.map(card => {
    const name = fuzzyNorm(candidateName(card));
    const number = fuzzyNorm(candidateNumber(card));
    const year = candidateYear(card);
    const context = candidateContext(card);

    if (!candidateId(card)) return { card, score: -1000 };
    if (!playerTokens.every(token => name.includes(token))) {
      return { card, score: -1000 };
    }
    if (rowYear && year && rowYear !== year) {
      return { card, score: -1000 };
    }
    if (rowNumber && number !== rowNumber) {
      return { card, score: -1000 };
    }

    let score = 100;

    if (brandTokens.length && brandTokens.every(token => context.includes(token))) {
      score += 40;
    } else if (brandTokens.some(token => context.includes(token))) {
      score += 15;
    } else {
      score -= 25;
    }

    const notesTokens = fuzzyNorm(row.notes)
      .split(/\s+/)
      .filter(token => token.length >= 3);

    if (notesTokens.length && notesTokens.some(token => context.includes(token))) {
      score += 8;
    }

    const typeTokens = fuzzyNorm(row.type)
      .split(/\s+/)
      .filter(token =>
        token &&
        !["base", "set", "parallel", "subset", "insert"].includes(token)
      );

    if (typeTokens.length && typeTokens.some(token => context.includes(token))) {
      score += 8;
    }

    return { card, score };
  }).sort((a,b) => b.score - a.score);

  for (const candidate of ranked) {
    if (candidate.score < 85) break;

    const parallel = matchParallel(candidate.card, row);
    const rowType = fuzzyNorm(row.type);

    if (rowType === "parallel" && !parallel) {
      continue;
    }

    return {
      cardId: candidateId(candidate.card),
      parallelId: parallel?.parallelId || null,
      parallelName: parallel?.parallelName || "",
      matchScore: candidate.score,
      matchedAt: Date.now(),
      matcherVersion: 25,
      catalogPrices: catalogPrices(candidate.card),
      candidate: {
        name: candidateName(candidate.card),
        year: candidateYear(candidate.card),
        number: candidateNumber(candidate.card),
        context: candidateContext(candidate.card)
      }
    };
  }

  return null;
}

export async function fetchBulkPricing(apiKey, cardIds) {
  const payload = await cardSightRequest(
    apiKey,
    "/v1/pricing/",
    {
      method: "POST",
      body: JSON.stringify({
        card_ids: cardIds,
        period: "1y",
        listing_type: "both",
        limit: 100
      })
    }
  );

  const data = unwrap(payload);

  return Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data)
      ? data
      : [];
}

function priceNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function recordParallelId(record) {
  return String(
    record?.parallel_id ||
    record?.parallelId ||
    record?.parallel?.id ||
    record?.parallel_variant?.id ||
    ""
  );
}

function recordParallelName(record) {
  return fuzzyNorm(
    record?.parallel_name ||
    record?.parallelName ||
    record?.parallel?.name ||
    record?.parallel_variant?.name ||
    ""
  );
}

function filterForParallel(records, match) {
  const list = Array.isArray(records) ? records : [];
  const hasParallelMetadata = list.some(record =>
    recordParallelId(record) || recordParallelName(record)
  );

  if (match?.parallelId) {
    return list.filter(record =>
      recordParallelId(record) === String(match.parallelId)
    );
  }

  if (!hasParallelMetadata) return list;

  return list.filter(record => {
    const id = recordParallelId(record);
    const name = recordParallelName(record);
    return !id && (!name || name === "base" || name === "base set");
  });
}

function median(values) {
  const nums = values
    .map(priceNumber)
    .filter(Number.isFinite)
    .sort((a,b) => a-b);

  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : (nums[mid - 1] + nums[mid]) / 2;
}

function datedRecords(records) {
  return (records || [])
    .map(record => ({
      ...record,
      _date: Date.parse(record?.date || record?.sale_date || ""),
      _price: priceNumber(record?.price)
    }))
    .filter(record =>
      Number.isFinite(record._date) &&
      Number.isFinite(record._price)
    )
    .sort((a,b) => a._date - b._date);
}

function currentMedian(records) {
  const sorted = datedRecords(records);
  if (!sorted.length) return null;

  const newest = sorted[sorted.length - 1]._date;
  const cutoff = newest - 90 * 24 * 60 * 60 * 1000;
  const recent = sorted.filter(record => record._date >= cutoff);

  return median(
    (recent.length ? recent : sorted).map(record => record._price)
  );
}

function oneYearChange(records) {
  const sorted = datedRecords(records);
  if (sorted.length < 2) return null;

  const oldestDate = sorted[0]._date;
  const newestDate = sorted[sorted.length - 1]._date;

  const firstWindowEnd = oldestDate + 30 * 24 * 60 * 60 * 1000;
  const lastWindowStart = newestDate - 30 * 24 * 60 * 60 * 1000;

  let first = sorted.filter(record => record._date <= firstWindowEnd);
  let last = sorted.filter(record => record._date >= lastWindowStart);

  if (first.length < 2) first = sorted.slice(0, Math.min(3, sorted.length));
  if (last.length < 2) last = sorted.slice(-Math.min(3, sorted.length));

  const firstMedian = median(first.map(record => record._price));
  const lastMedian = median(last.map(record => record._price));

  if (
    !Number.isFinite(firstMedian) ||
    !Number.isFinite(lastMedian) ||
    firstMedian === 0
  ) {
    return null;
  }

  return ((lastMedian - firstMedian) / firstMedian) * 100;
}

function rawRecords(pricingData) {
  return (
    pricingData?.raw?.records ||
    pricingData?.ungraded?.records ||
    []
  );
}

function gradedGroups(pricingData) {
  return Array.isArray(pricingData?.graded)
    ? pricingData.graded
    : [];
}

function gradeRecords(pricingData, companyName, gradeValue) {
  const company = gradedGroups(pricingData).find(group =>
    fuzzyNorm(
      group?.company_name ||
      group?.companyName ||
      group?.name ||
      ""
    ).includes(fuzzyNorm(companyName))
  );

  if (!company) return [];

  const grades = Array.isArray(company?.grades) ? company.grades : [];

  const grade = grades.find(item =>
    String(
      item?.grade_value ??
      item?.gradeValue ??
      item?.grade ??
      ""
    ).trim() === String(gradeValue)
  );

  return grade?.records || [];
}

function pricingResultCardId(result) {
  return String(
    result?.card_id ||
    result?.cardId ||
    result?.data?.card?.id ||
    result?.data?.card_id ||
    ""
  );
}

function pricingResultData(result) {
  return result?.data || result?.pricing || result;
}

export function buildSummaryFromPricing(result, match) {
  const data = pricingResultData(result);

  const raw = filterForParallel(rawRecords(data), match);
  const psa9 = filterForParallel(gradeRecords(data, "PSA", "9"), match);
  const psa10 = filterForParallel(gradeRecords(data, "PSA", "10"), match);

  return {
    ungraded: currentMedian(raw),
    psa9: currentMedian(psa9),
    grade9: currentMedian(psa9),
    psa10: currentMedian(psa10),
    changes: {
      ungraded: oneYearChange(raw),
      psa9: oneYearChange(psa9),
      grade9: oneYearChange(psa9),
      psa10: oneYearChange(psa10)
    },
    salesCounts: {
      ungraded: raw.length,
      psa9: psa9.length,
      psa10: psa10.length
    },
    source: "CardSight",
    cardId: match?.cardId || pricingResultCardId(result),
    parallelId: match?.parallelId || null,
    parallelName: match?.parallelName || "",
    updatedAt: Date.now()
  };
}

export function resultMapByCardId(results) {
  const map = new Map();

  for (const result of results || []) {
    const id = pricingResultCardId(result);
    if (id) map.set(id, result);
  }

  return map;
}

export function groupUnmatchedRows(cards, matches, { retryUnresolved = false } = {}) {
  const groups = new Map();

  for (const card of cards) {
    const existing = matches[card.key] || {};

    if (existing.cardId) continue;

    if (
      existing.unresolved &&
      existing.matcherVersion === 25 &&
      !retryUnresolved
    ) {
      continue;
    }

    const key = `${fuzzyNorm(card.player)}|${card.year}`;

    if (!groups.has(key)) {
      groups.set(key, {
        player: card.player,
        year: card.year,
        cards: []
      });
    }

    groups.get(key).cards.push(card);
  }

  return [...groups.values()];
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
