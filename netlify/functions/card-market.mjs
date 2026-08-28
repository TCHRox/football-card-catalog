const SALES_URL = "https://thecardapi.com/api/v1/market/sales";

function json(body, status = 200, cacheSeconds = 0) {
  const headers = { "content-type": "application/json; charset=utf-8" };

  if (cacheSeconds > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
    headers["Netlify-CDN-Cache-Control"] = `public, durable, max-age=${cacheSeconds}`;
  } else {
    headers["Cache-Control"] = "no-store";
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function escapePhrase(value) {
  return String(value || "")
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedBrand(brand) {
  return normalize(brand)
    .replace(/\bdonruss optics\b/g, "donruss optic")
    .replace(/\bpanini\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuery(card) {
  const player = escapePhrase(card.player);
  const brand = escapePhrase(card.brand);
  const type = escapePhrase(card.type);
  const number = escapePhrase(card.number);

  // Exact player phrase plus identifying card terms. Exclude common bulk/reprint
  // false positives while keeping the query understandable to the sales API.
  return [
    player ? `"${player}"` : "",
    card.year,
    brand,
    type && !/^parallel$/i.test(type) ? type : "",
    number,
    "-(lot,break,set,reprint,digital)"
  ].filter(Boolean).join(" ");
}

function cardTitleScore(sale, card) {
  const title = normalize(sale.title || "");
  const structuredPlayer = normalize(sale.player || "");
  const structuredNumber = normalize(sale.card_number || "");
  const structuredYear = String(sale.year || "");
  const structuredSet = normalize(sale.card_set || "");
  const manufacturer = normalize(sale.manufacturer || "");

  const playerTokens = tokens(card.player);
  const brandTokens = tokens(normalizedBrand(card.brand));
  const typeTokens = tokens(card.type).filter(t => !["base", "parallel", "subset"].includes(t));
  const notesTokens = tokens(card.notes).filter(t => t.length >= 3).slice(0, 5);
  const number = normalize(card.number);
  const year = String(card.year || "");

  let score = 0;

  const playerMatches = playerTokens.length &&
    playerTokens.every(t => title.includes(t) || structuredPlayer.includes(t));
  if (!playerMatches) return -100;
  score += 35;

  if (year && (title.includes(year) || structuredYear === year || structuredSet.includes(year))) {
    score += 15;
  } else if (year) {
    score -= 22;
  }

  if (number) {
    const numberMatch =
      structuredNumber === number ||
      title.includes(` ${number} `) ||
      title.endsWith(` ${number}`) ||
      title.includes(` ${number} psa`) ||
      title.includes(` ${number} bgs`) ||
      title.includes(` ${number} sgc`) ||
      title.includes(` ${number} cgc`);

    if (numberMatch) score += 28;
    else score -= 25;
  }

  if (brandTokens.length) {
    const brandMatches = brandTokens.some(t =>
      title.includes(t) || structuredSet.includes(t) || manufacturer.includes(t)
    );
    if (brandMatches) score += 13;
    else score -= 12;
  }

  if (typeTokens.length && typeTokens.some(t => title.includes(t))) score += 5;
  if (notesTokens.length && notesTokens.some(t => title.includes(t))) score += 7;

  if (String(card.rookie).toUpperCase() === "Y" && /\b(rc|rookie)\b/i.test(sale.title || "")) {
    score += 3;
  }

  if (/\b(lot|you pick|pick your|reprint|digital|custom)\b/i.test(sale.title || "")) {
    score -= 35;
  }

  return score;
}

function median(values) {
  const nums = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a,b) => a-b);

  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : (nums[mid - 1] + nums[mid]) / 2;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((a,b) => a+b, 0) / nums.length;
}

function gradeLabel(sale) {
  const grader = String(sale.grader || "").trim().toUpperCase();
  const grade = String(sale.grade || "").trim();

  if (grader && grade) return `${grader} ${grade}`;

  // Treat explicit absence of professional grading as raw.
  if (!grader && !grade) return "Ungraded";

  return [grader, grade].filter(Boolean).join(" ");
}

function priceGroups(sales) {
  const groups = new Map();

  for (const sale of sales) {
    const label = gradeLabel(sale);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(Number(sale.price));
  }

  return [...groups.entries()]
    .map(([label, prices]) => ({
      label,
      value: median(prices),
      average: average(prices),
      sales: prices.length
    }))
    .filter(item => item.value !== null)
    .sort((a,b) => {
      if (a.label === "Ungraded") return -1;
      if (b.label === "Ungraded") return 1;
      return b.value - a.value;
    });
}

async function fetchSales(apiKey, card) {
  const params = new URLSearchParams({
    q: buildQuery(card),
    category: "sports",
    limit: "250",
    sort: "date_desc"
  });

  const response = await fetch(`${SALES_URL}?${params.toString()}`, {
    headers: {
      "x-market-api-key": apiKey,
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
    const message = payload.detail || payload.error || payload.message ||
      `The Card API returned HTTP ${response.status}.`;
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  return {
    payload,
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    rateLimitLimit: response.headers.get("x-ratelimit-limit")
  };
}

export default async (request) => {
  try {
    const apiKey = process.env.THE_CARD_API_KEY || "";

    if (!apiKey) {
      return json({
        found: false,
        code: "THE_CARD_API_NOT_CONFIGURED",
        message: "THE_CARD_API_KEY is not configured in Netlify."
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
        message: "Not enough card information is available for market lookup."
      }, 200, 1800);
    }

    const { payload, rateLimitRemaining, rateLimitLimit } =
      await fetchSales(apiKey, card);

    const rawSales = Array.isArray(payload.data) ? payload.data : [];

    const matched = rawSales
      .map(sale => ({
        sale,
        score: cardTitleScore(sale, card)
      }))
      .filter(item => item.score >= 55)
      .sort((a,b) => {
        const dateDiff = Date.parse(b.sale.sale_date || "") -
          Date.parse(a.sale.sale_date || "");
        return dateDiff || b.score - a.score;
      })
      .map(item => item.sale);

    if (!matched.length) {
      return json({
        found: false,
        message: "No trustworthy completed-sale matches were found in the API's current lookback window.",
        coverageDateFrom: payload.meta?.coverage_date_from || "",
        coverageDateTo: payload.meta?.coverage_date_to || "",
        rateLimitRemaining,
        rateLimitLimit
      }, 200, 1800);
    }

    const sales = matched.slice(0, 40).map(sale => ({
      date: sale.sale_date || "",
      title: sale.title || "",
      numericPrice: Number(sale.price),
      price: sale.price,
      url: sale.listing_url || "",
      platform: sale.platform || "",
      listingType: sale.listing_type || "",
      grader: sale.grader || "",
      grade: sale.grade || "",
      gradeLabel: gradeLabel(sale),
      imageUrl: sale.thumbnail_url || sale.image_url || ""
    }));

    const prices = priceGroups(matched);

    const rawMatched = matched.filter(sale => gradeLabel(sale) === "Ungraded");
    const chartSales = (rawMatched.length >= 2 ? rawMatched : matched)
      .slice(0, 40)
      .map(sale => ({
        date: sale.sale_date || "",
        title: sale.title || "",
        numericPrice: Number(sale.price),
        price: sale.price,
        url: sale.listing_url || "",
        gradeLabel: gradeLabel(sale)
      }));

    return json({
      found: true,
      source: "The Card API",
      prices,
      sales,
      chartSales,
      totalMatched: matched.length,
      overallMedian: median(matched.map(s => s.price)),
      coverageDateFrom: payload.meta?.coverage_date_from || "",
      coverageDateTo: payload.meta?.coverage_date_to || "",
      chartLabel: rawMatched.length >= 2
        ? "Recent ungraded sold prices"
        : "Recent matched sold prices",
      planNote: payload.meta?.coverage_date_from && payload.meta?.coverage_date_to
        ? "Coverage is determined by your The Card API plan."
        : "",
      rateLimitRemaining,
      rateLimitLimit,
      fetchedAt: new Date().toISOString()
    }, 200, 1800);

  } catch (error) {
    if (error.status === 401) {
      return json({
        found: false,
        code: "THE_CARD_API_INVALID_KEY",
        message: "The Card API rejected THE_CARD_API_KEY."
      }, 401);
    }

    if (error.status === 429) {
      return json({
        found: false,
        code: "THE_CARD_API_LIMIT",
        message: "The Card API daily sales allowance has been reached. It resets at 00:00 UTC."
      }, 429);
    }

    return json({
      found: false,
      error: error.message
    }, 500);
  }
};
