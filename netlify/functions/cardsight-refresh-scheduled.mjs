import {
  loadMarketState
} from "./_cardsight-lib.mjs";

export default async (request) => {
  try {
    const adminPassword = process.env.CARD_CATALOG_ADMIN_PASSWORD || "";
    const apiKey = process.env.CARDSIGHTAI_API_KEY || "";

    if (!adminPassword || !apiKey) return;

    const { status } = await loadMarketState();

    if (status?.running) return;

    const refreshDays = Math.max(
      1,
      parseInt(process.env.CARDSIGHT_REFRESH_DAYS || "7", 10) || 7
    );

    const lastRefresh = Number(
      status?.lastPriceRefreshAt ||
      status?.lastCompletedAt ||
      0
    );

    const due =
      !lastRefresh ||
      Date.now() - lastRefresh >= refreshDays * 24 * 60 * 60 * 1000;

    if (!due) return;

    const origin = new URL(request.url).origin;

    await fetch(
      `${origin}/.netlify/functions/cardsight-sync-background`,
      {
        method: "POST",
        headers: {
          "X-Catalog-Admin": adminPassword
        }
      }
    );
  } catch (error) {
    console.error("Scheduled CardSight refresh failed:", error);
  }
};

export const config = {
  schedule: "@daily"
};
