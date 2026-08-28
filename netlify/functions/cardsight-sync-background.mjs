import {
  MARKET_INDEX_KEY,
  MATCH_INDEX_KEY,
  loadSheetCards,
  loadMarketState,
  saveStatus,
  groupUnmatchedRows,
  fetchCandidateCards,
  matchRowToCandidate,
  buildSummaryFromCatalogMatch,
  fetchBulkPricing,
  resultMapByCardId,
  buildSummaryFromPricing,
  resetApiCallStats,
  getApiCallStats
} from "./_cardsight-lib.mjs";

const MAX_MATCH_API_CALLS_PER_RUN = 600;
const PRICE_BATCH_SIZE = 100;
const MATCH_STATUS_EVERY_GROUPS = 5;

function authorized(request) {
  const configured = process.env.CARD_CATALOG_ADMIN_PASSWORD || "";
  const supplied = request.headers.get("x-catalog-admin") || "";
  return Boolean(configured) && supplied === configured;
}

function counts(cards, matches, summaries) {
  const totalRows = cards.length;

  const matchedRows = cards.filter(card =>
    Boolean(matches[card.key]?.cardId)
  ).length;

  const unresolvedRows = cards.filter(card =>
    matches[card.key]?.unresolved &&
    matches[card.key]?.matcherVersion === 25
  ).length;

  const pendingRows = Math.max(
    0,
    totalRows - matchedRows - unresolvedRows
  );

  const valuedRows = cards.filter(card =>
    Number.isFinite(Number(summaries[card.key]?.ungraded))
  ).length;

  return {
    totalRows,
    matchedRows,
    unresolvedRows,
    pendingRows,
    valuedRows
  };
}

async function saveProgress(store, payload) {
  await saveStatus(store, {
    configured: true,
    running: true,
    error: "",
    apiCallsThisRun: getApiCallStats().calls,
    ...payload
  });
}

export default async (request) => {
  if (!authorized(request)) {
    return new Response("Unauthorized", { status: 401 });
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

  resetApiCallStats();

  let cards = [];

  try {
    if (!apiKey) {
      await saveStatus(store, {
        configured: false,
        running: false,
        phase: "error",
        error: "CARDSIGHTAI_API_KEY is not configured."
      });
      return;
    }

    cards = await loadSheetCards();

    // v24 unresolved records had no matcherVersion. They are intentionally
    // retried once under the corrected v25 throttling/matcher.
    const groups = groupUnmatchedRows(cards, matches, {
      retryUnresolved: false
    });

    let currentCounts = counts(cards, matches, summaries);

    await saveProgress(store, {
      phase: "matching",
      phaseLabel: "Matching cards to CardSight",
      startedAt,
      matchGroupsTotal: groups.length,
      matchGroupsProcessed: 0,
      ...currentCounts
    });

    let groupsProcessed = 0;

    for (const group of groups) {
      if (getApiCallStats().calls >= MAX_MATCH_API_CALLS_PER_RUN) {
        break;
      }

      let candidates = [];

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

        // A transient one-off error should leave the group pending, not falsely
        // label every row as "unmatched."
        groupsProcessed += 1;
        continue;
      }

      for (const card of group.cards) {
        const match = matchRowToCandidate(card, candidates);

        if (match) {
          matches[card.key] = match;

          summaries[card.key] = buildSummaryFromCatalogMatch(
            match,
            summaries[card.key] || {}
          );
        } else {
          matches[card.key] = {
            unresolved: true,
            matcherVersion: 25,
            lastTriedAt: Date.now(),
            reason: "No confident CardSight catalog match"
          };
        }
      }

      groupsProcessed += 1;

      if (
        groupsProcessed % MATCH_STATUS_EVERY_GROUPS === 0 ||
        groupsProcessed === groups.length
      ) {
        await Promise.all([
          store.setJSON(MATCH_INDEX_KEY, matches),
          store.setJSON(MARKET_INDEX_KEY, summaries)
        ]);

        currentCounts = counts(cards, matches, summaries);

        await saveProgress(store, {
          phase: "matching",
          phaseLabel: "Matching cards to CardSight",
          startedAt,
          matchGroupsTotal: groups.length,
          matchGroupsProcessed: groupsProcessed,
          ...currentCounts
        });
      }
    }

    await Promise.all([
      store.setJSON(MATCH_INDEX_KEY, matches),
      store.setJSON(MARKET_INDEX_KEY, summaries)
    ]);

    currentCounts = counts(cards, matches, summaries);

    const matchedCards = cards.filter(card =>
      Boolean(matches[card.key]?.cardId)
    );

    const uniqueIds = [...new Set(
      matchedCards.map(card => matches[card.key].cardId)
    )];

    await saveProgress(store, {
      phase: "pricing",
      phaseLabel: "Refreshing market prices",
      startedAt,
      matchGroupsTotal: groups.length,
      matchGroupsProcessed: groupsProcessed,
      priceIdsTotal: uniqueIds.length,
      priceIdsProcessed: 0,
      ...currentCounts
    });

    let idsProcessed = 0;

    for (let i = 0; i < uniqueIds.length; i += PRICE_BATCH_SIZE) {
      const ids = uniqueIds.slice(i, i + PRICE_BATCH_SIZE);

      let results = [];

      try {
        results = await fetchBulkPricing(apiKey, ids);
      } catch (error) {
        if ([401, 402, 403, 429].includes(error.status)) {
          throw error;
        }

        idsProcessed += ids.length;
        continue;
      }

      const byId = resultMapByCardId(results);
      const idSet = new Set(ids);

      for (const card of matchedCards) {
        const match = matches[card.key];

        if (!idSet.has(match.cardId)) continue;

        const result = byId.get(match.cardId);
        if (!result) continue;

        summaries[card.key] = buildSummaryFromPricing(
          result,
          match
        );
      }

      idsProcessed += ids.length;

      await store.setJSON(MARKET_INDEX_KEY, summaries);

      currentCounts = counts(cards, matches, summaries);

      await saveProgress(store, {
        phase: "pricing",
        phaseLabel: "Refreshing market prices",
        startedAt,
        matchGroupsTotal: groups.length,
        matchGroupsProcessed: groupsProcessed,
        priceIdsTotal: uniqueIds.length,
        priceIdsProcessed: idsProcessed,
        ...currentCounts
      });
    }

    currentCounts = counts(cards, matches, summaries);
    const finishedAt = Date.now();

    await Promise.all([
      store.setJSON(MARKET_INDEX_KEY, summaries),
      store.setJSON(MATCH_INDEX_KEY, matches)
    ]);

    await saveStatus(store, {
      configured: true,
      running: false,
      phase: "complete",
      phaseLabel: "Market sync complete",
      startedAt,
      lastCompletedAt: finishedAt,
      lastPriceRefreshAt: finishedAt,
      matchGroupsTotal: groups.length,
      matchGroupsProcessed: groupsProcessed,
      priceIdsTotal: uniqueIds.length,
      priceIdsProcessed: idsProcessed,
      apiCallsThisRun: getApiCallStats().calls,
      error: "",
      ...currentCounts
    });
  } catch (error) {
    const currentCounts = cards.length
      ? counts(cards, matches, summaries)
      : {};

    await Promise.all([
      store.setJSON(MARKET_INDEX_KEY, summaries),
      store.setJSON(MATCH_INDEX_KEY, matches)
    ]);

    let message = error.message;

    if (error.status === 401) {
      message = "CardSight rejected CARDSIGHTAI_API_KEY.";
    } else if (error.status === 402) {
      message = "CardSight API call allowance has been exhausted for the current plan.";
    } else if (error.status === 429) {
      message = "CardSight continued to rate-limit the sync after automatic retries.";
    } else if (error.status === 403) {
      message = "CardSight denied this API request. Check the account/API key permissions.";
    }

    await saveStatus(store, {
      configured: Boolean(apiKey),
      running: false,
      phase: "error",
      phaseLabel: "Market sync stopped",
      startedAt,
      error: message,
      errorStatus: error.status || 500,
      apiCallsThisRun: getApiCallStats().calls,
      ...currentCounts
    });
  }
};

export const config = {
  background: true
};
