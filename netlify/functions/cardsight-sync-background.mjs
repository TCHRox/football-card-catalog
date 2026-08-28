import {
  MARKET_INDEX_KEY,
  MATCH_INDEX_KEY,
  loadSheetCards,
  loadMarketState,
  saveStatus,
  groupUnmatchedRows,
  fetchCandidateCards,
  matchRowToCandidate,
  fetchBulkPricing,
  resultMapByCardId,
  buildSummaryFromPricing,
  sleep
} from "./_cardsight-lib.mjs";

const MAX_MATCH_CALLS_PER_RUN = 600;
const API_DELAY_MS = 275;
const PRICE_BATCH_SIZE = 100;

function authorized(request) {
  const configured = process.env.CARD_CATALOG_ADMIN_PASSWORD || "";
  const supplied = request.headers.get("x-catalog-admin") || "";
  return Boolean(configured) && supplied === configured;
}

function statusCounts(cards, matches, summaries) {
  const totalRows = cards.length;
  const matchedRows = cards.filter(card => matches[card.key]?.cardId).length;
  const valuedRows = cards.filter(card =>
    Number.isFinite(Number(summaries[card.key]?.ungraded))
  ).length;

  return {
    totalRows,
    matchedRows,
    valuedRows,
    unresolvedRows: Math.max(0, totalRows - matchedRows)
  };
}

export default async (request) => {
  if (!authorized(request)) {
    return;
  }

  const apiKey = process.env.CARDSIGHTAI_API_KEY || "";
  const {
    store,
    summaries,
    matches,
    status: oldStatus
  } = await loadMarketState();

  const startedAt = Date.now();

  if (
    oldStatus?.running &&
    Number(oldStatus.startedAt || 0) > Date.now() - 20 * 60 * 1000
  ) {
    return;
  }

  let cards = [];

  try {
    if (!apiKey) {
      await saveStatus(store, {
        ...oldStatus,
        configured: false,
        running: false,
        error: "CARDSIGHTAI_API_KEY is not configured."
      });
      return;
    }

    cards = await loadSheetCards();

    let counts = statusCounts(cards, matches, summaries);

    await saveStatus(store, {
      ...oldStatus,
      configured: true,
      running: true,
      phase: "matching",
      phaseLabel: "Matching cards to CardSight",
      startedAt,
      error: "",
      ...counts
    });

    // Match only groups that still contain unmapped rows. One API call can
    // resolve many cards for the same player/year.
    const groups = groupUnmatchedRows(cards, matches);
    let matchCalls = 0;

    for (const group of groups) {
      if (matchCalls >= MAX_MATCH_CALLS_PER_RUN) break;

      let candidates;

      try {
        candidates = await fetchCandidateCards(
          apiKey,
          group.player,
          group.year
        );
      } catch (error) {
        if ([401, 402, 403, 429].includes(error.status)) {
          throw error;
        }
        continue;
      }

      matchCalls += 1;

      for (const card of group.cards) {
        const match = matchRowToCandidate(card, candidates);

        if (match) {
          matches[card.key] = match;
        } else {
          matches[card.key] = {
            unresolved: true,
            lastTriedAt: Date.now(),
            reason: "No confident CardSight catalog match"
          };
        }
      }

      if (matchCalls % 20 === 0) {
        await store.setJSON(MATCH_INDEX_KEY, matches);
        counts = statusCounts(cards, matches, summaries);

        await saveStatus(store, {
          configured: true,
          running: true,
          phase: "matching",
          phaseLabel: "Matching cards to CardSight",
          startedAt,
          matchCalls,
          ...counts
        });
      }

      await sleep(API_DELAY_MS);
    }

    await store.setJSON(MATCH_INDEX_KEY, matches);

    counts = statusCounts(cards, matches, summaries);

    await saveStatus(store, {
      configured: true,
      running: true,
      phase: "pricing",
      phaseLabel: "Refreshing market prices",
      startedAt,
      matchCalls,
      ...counts
    });

    // Price unique canonical card IDs in bulk. Rows that are parallels share the
    // base card call; the returned listing records are then split by parallel ID.
    const matchedCards = cards.filter(card => matches[card.key]?.cardId);
    const uniqueIds = [...new Set(
      matchedCards.map(card => matches[card.key].cardId)
    )];

    let priceCalls = 0;

    for (let i = 0; i < uniqueIds.length; i += PRICE_BATCH_SIZE) {
      const ids = uniqueIds.slice(i, i + PRICE_BATCH_SIZE);

      let results;

      try {
        results = await fetchBulkPricing(apiKey, ids);
      } catch (error) {
        if ([401, 402, 403, 429].includes(error.status)) {
          throw error;
        }
        await sleep(API_DELAY_MS);
        continue;
      }

      priceCalls += 1;
      const byId = resultMapByCardId(results);
      const idSet = new Set(ids);

      for (const card of matchedCards) {
        const match = matches[card.key];
        if (!idSet.has(match.cardId)) continue;

        const result = byId.get(match.cardId);
        if (!result) continue;

        summaries[card.key] = buildSummaryFromPricing(result, match);
      }

      await store.setJSON(MARKET_INDEX_KEY, summaries);

      if (priceCalls % 5 === 0) {
        counts = statusCounts(cards, matches, summaries);

        await saveStatus(store, {
          configured: true,
          running: true,
          phase: "pricing",
          phaseLabel: "Refreshing market prices",
          startedAt,
          matchCalls,
          priceCalls,
          priceBatch: Math.min(i + PRICE_BATCH_SIZE, uniqueIds.length),
          priceTotal: uniqueIds.length,
          ...counts
        });
      }

      await sleep(API_DELAY_MS);
    }

    counts = statusCounts(cards, matches, summaries);
    const finishedAt = Date.now();

    await store.setJSON(MARKET_INDEX_KEY, summaries);
    await store.setJSON(MATCH_INDEX_KEY, matches);

    await saveStatus(store, {
      configured: true,
      running: false,
      phase: "complete",
      phaseLabel: "Market sync complete",
      startedAt,
      lastCompletedAt: finishedAt,
      lastPriceRefreshAt: finishedAt,
      matchCalls,
      priceCalls,
      ...counts
    });
  } catch (error) {
    const counts = cards.length
      ? statusCounts(cards, matches, summaries)
      : {};

    await store.setJSON(MARKET_INDEX_KEY, summaries);
    await store.setJSON(MATCH_INDEX_KEY, matches);

    await saveStatus(store, {
      configured: Boolean(apiKey),
      running: false,
      phase: "error",
      phaseLabel: "Market sync stopped",
      startedAt,
      error: error.message,
      errorStatus: error.status || 500,
      ...counts
    });
  }
};

export const config = {
  background: true
};
