import {
  loadMarketState
} from "./_cardsight-lib.mjs";

export default async () => {
  try {
    const { summaries, status } = await loadMarketState();

    return new Response(JSON.stringify({
      summaries,
      status: {
        configured: Boolean(process.env.CARDSIGHTAI_API_KEY),
        ...status
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
