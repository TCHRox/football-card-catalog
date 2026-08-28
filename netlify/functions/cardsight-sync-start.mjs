import {
  loadSheetCards,
  loadMarketState,
  saveStatus,
  cardSightRequest
} from "./_cardsight-lib.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function authorized(request) {
  const configured = process.env.CARD_CATALOG_ADMIN_PASSWORD || "";
  const supplied = request.headers.get("x-catalog-admin") || "";

  return {
    configured: Boolean(configured),
    ok: Boolean(configured) && supplied === configured
  };
}

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "Use POST." }, 405);
    }

    const auth = authorized(request);

    if (!auth.configured) {
      return json({
        error: "CARD_CATALOG_ADMIN_PASSWORD is not configured in Netlify."
      }, 503);
    }

    if (!auth.ok) {
      return json({ error: "Incorrect catalog admin password." }, 401);
    }

    const apiKey = process.env.CARDSIGHTAI_API_KEY || "";

    if (!apiKey) {
      return json({
        error: "CARDSIGHTAI_API_KEY is not configured in Netlify."
      }, 503);
    }

    const {
      store,
      summaries,
      matches,
      status: oldStatus
    } = await loadMarketState();

    if (
      oldStatus?.running &&
      Number(oldStatus.startedAt || 0) > Date.now() - 20 * 60 * 1000
    ) {
      return json({
        ok: true,
        alreadyRunning: true,
        status: oldStatus
      }, 202);
    }

    // Validate the CardSight key before we launch an opaque background job.
    // This is intentionally tiny: one catalog result.
    await cardSightRequest(
      apiKey,
      "/v1/catalog/cards?take=1&skip=0"
    );

    const cards = await loadSheetCards();
    const totalRows = cards.length;
    const matchedRows = cards.filter(card => matches[card.key]?.cardId).length;
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

    const queuedStatus = {
      configured: true,
      running: false,
      phase: "queued",
      phaseLabel: "Market sync queued",
      queuedAt: Date.now(),
      error: "",
      totalRows,
      matchedRows,
      unresolvedRows,
      pendingRows,
      valuedRows,
      apiCallsThisRun: 1
    };

    await saveStatus(store, queuedStatus);

    const origin = new URL(request.url).origin;

    const backgroundResponse = await fetch(
      `${origin}/.netlify/functions/cardsight-sync-background?source=manual`,
      {
        method: "POST",
        headers: {
          "X-Catalog-Admin": request.headers.get("x-catalog-admin") || ""
        }
      }
    );

    if (!backgroundResponse.ok && backgroundResponse.status !== 202) {
      const text = await backgroundResponse.text();

      const failed = {
        ...queuedStatus,
        phase: "error",
        error: `Netlify could not start the background sync (${backgroundResponse.status}). ${text.slice(0, 160)}`
      };

      await saveStatus(store, failed);
      return json({ error: failed.error, status: failed }, 502);
    }

    return json({
      ok: true,
      status: queuedStatus
    }, 202);
  } catch (error) {
    const message =
      error.status === 401
        ? "CardSight rejected CARDSIGHTAI_API_KEY."
        : error.status === 429
          ? "CardSight is rate-limiting requests. Wait a few seconds and try again."
          : error.message;

    return json({
      error: message,
      statusCode: error.status || 500
    }, error.status === 401 ? 401 : 502);
  }
};
