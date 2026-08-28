const SERPER_SEARCH = "https://google.serper.dev/search";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|td|th|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function norm(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/["'`:#()+\[\]{}<>|\\/]/g, " ")
    .replace(/[–—_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchQuery(card) {
  return [
    safeSearchText(card.player),
    safeSearchText(card.year),
    safeSearchText(card.brand),
    safeSearchText(card.type),
    safeSearchText(card.number),
    safeSearchText(card.notes),
    "SportsCardsPro football"
  ].filter(Boolean).join(" ");
}

function scoreResult(result, card) {
  const link = String(result.link || "");
  const title = String(result.title || "");
  const text = norm(`${title} ${link}`);

  let score = /sportscardspro\.com\/game\/football-cards/i.test(link) ? 50 : -100;

  const playerTokens = norm(card.player).split(/\s+/).filter(Boolean);
  if (playerTokens.every(t => text.includes(t))) score += 25;

  if (card.year && text.includes(norm(card.year))) score += 12;

  const brandTokens = norm(card.brand)
    .replace(/donruss optics?/g, "donruss optic")
    .split(/\s+/)
    .filter(Boolean);

  if (brandTokens.some(t => text.includes(t))) score += 10;

  const number = norm(card.number);
  if (number && text.includes(number)) score += 18;

  const notes = norm(card.notes);
  if (notes && notes.split(/\s+/).some(t => t.length > 2 && text.includes(t))) score += 6;

  return score;
}

async function locatePage(apiKey, card) {
  if (card.preferredUrl && /sportscardspro\.com\/game\/football-cards/i.test(card.preferredUrl)) {
    return card.preferredUrl;
  }

  if (!apiKey) return "";

  const response = await fetch(SERPER_SEARCH, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: searchQuery(card),
      gl: "us",
      hl: "en",
      num: 10
    })
  });

  if (!response.ok) return "";

  const data = await response.json();
  const candidates = (data.organic || [])
    .filter(item => /sportscardspro\.com\/game\/football-cards/i.test(item.link || ""))
    .map(item => ({ ...item, score: scoreResult(item, card) }))
    .sort((a,b) => b.score - a.score);

  return candidates[0]?.score >= 70 ? candidates[0].link : "";
}

function parsePrice(value) {
  const n = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parsePriceGuide(html) {
  const text = stripTags(html);
  const start = text.toLowerCase().lastIndexOf("full price guide:");
  const section = start >= 0 ? text.slice(start, start + 6000) : text;

  const labels = [
    "Ungraded",
    "Grade 1",
    "Grade 2",
    "Grade 3",
    "Grade 4",
    "Grade 5",
    "Grade 6",
    "Grade 7",
    "Grade 8",
    "Grade 9",
    "Grade 9.5",
    "TAG 10",
    "ACE 10",
    "SGC 10",
    "CGC 10",
    "PSA 10",
    "BGS 10",
    "BGS 10 Black",
    "CGC 10 Pristine"
  ];

  const prices = [];

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = section.match(new RegExp(`${escaped}\\s+(\\$[0-9,.]+|-)`, "i"));

    if (!match) continue;

    prices.push({
      label,
      value: match[1] === "-" ? null : parsePrice(match[1])
    });
  }

  return prices;
}

function stripAnchorText(value) {
  return stripTags(value).replace(/\s+/g, " ").trim();
}

function parseSales(html) {
  const anchors = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const href = decodeHtml(match[1]);
    if (!/(?:ebay\.com|ebaypartnernetwork|rover\.ebay)/i.test(href)) continue;

    const title = stripAnchorText(match[2]);
    if (!title || /subscribe|buy\/sell|ebay deal/i.test(title)) continue;

    anchors.push({
      href,
      title,
      start: match.index,
      end: anchorPattern.lastIndex
    });
  }

  const sales = [];
  const seen = new Set();

  for (const anchor of anchors) {
    const before = stripTags(html.slice(Math.max(0, anchor.start - 1100), anchor.start));
    const after = stripTags(html.slice(anchor.end, Math.min(html.length, anchor.end + 450)));

    const dates = [...before.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)];
    const date = dates.length ? dates[dates.length - 1][1] : "";

    const priceMatch = after.match(/\$([0-9][0-9,.]*)/);
    const numericPrice = priceMatch ? parsePrice(priceMatch[0]) : null;

    if (!date || numericPrice === null) continue;

    const key = `${date}|${anchor.title}|${numericPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sales.push({
      date,
      title: anchor.title,
      price: priceMatch[0],
      numericPrice,
      url: anchor.href
    });
  }

  return sales
    .sort((a,b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 30);
}

async function fetchSportsCardsPro(url) {
  const response = await fetch(url, {
    headers: HEADERS,
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`SportsCardsPro returned HTTP ${response.status}.`);
  }

  return {
    html: await response.text(),
    finalUrl: response.url || url
  };
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const card = {
      player: url.searchParams.get("player") || "",
      year: url.searchParams.get("year") || "",
      brand: url.searchParams.get("brand") || "",
      type: url.searchParams.get("type") || "",
      number: url.searchParams.get("number") || "",
      rookie: url.searchParams.get("rookie") || "",
      notes: url.searchParams.get("notes") || "",
      preferredUrl: url.searchParams.get("preferredUrl") || ""
    };

    if (!card.player || !card.year || !card.brand || !card.number) {
      return json({
        found: false,
        error: "Not enough identifying card data for market lookup."
      }, 400);
    }

    const sourceUrl = await locatePage(process.env.SERPER_API_KEY || "", card);

    if (!sourceUrl) {
      return json({
        found: false,
        message: "No reliable SportsCardsPro page matched this card."
      }, 200, 21600);
    }

    const page = await fetchSportsCardsPro(sourceUrl);
    const prices = parsePriceGuide(page.html);
    const sales = parseSales(page.html);

    if (!prices.length && !sales.length) {
      return json({
        found: false,
        sourceUrl: page.finalUrl,
        message: "SportsCardsPro matched the card, but its market data could not be read."
      }, 200, 3600);
    }

    return json({
      found: true,
      source: "SportsCardsPro",
      sourceUrl: page.finalUrl,
      prices,
      sales,
      fetchedAt: new Date().toISOString()
    }, 200, 21600);

  } catch (error) {
    return json({
      found: false,
      error: error.message
    }, 500);
  }
};
