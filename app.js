const CONFIG = {
  siteTitle: "Football Card Archive",
  dataEndpoint: "/.netlify/functions/cards",
  imageManifest: "/card-images.json",
  imageBatchEndpoint: "/.netlify/functions/card-images-batch",
  customImageEndpoint: "/.netlify/functions/custom-card-image",
  marketIndexEndpoint: "/.netlify/functions/scp-market-index",
  marketSyncEndpoint: "/.netlify/functions/scp-sync-start",
  imageCacheStorageKey: "football-card-archive-image-cache-v5",
  imageBatchSize: 8,
  imageBatchConcurrency: 2,
  initialImageLookahead: 48,
  defaultPageSize: 250,
  marketPollMs: 4000
};

const ALIASES = {
  player: [
    "player", "player name", "player names", "player(s)", "players",
    "athlete", "athlete name", "subject", "subject name", "full name"
  ],
  firstName: ["first name", "firstname", "first"],
  lastName: ["last name", "lastname", "last", "surname"],
  year: ["year", "card year", "season", "yr"],
  rookie: ["rookie", "rookie card", "rc", "is rookie"],
  set: ["set", "set name", "product", "product name", "brand", "card set"],
  cardType: ["type", "card type", "subset", "sub set", "insert", "base/subset"],
  cardNumber: [
    "card #", "card no", "card no.", "card number", "card num",
    "card num.", "number", "no.", "#"
  ],
  quantity: ["qty", "quantity", "count", "copies", "owned"],
  purchasePrice: ["purchase price", "cost", "price paid", "paid", "purchase cost"],
  value: ["market value", "value", "current value", "estimated value", "est value"],
  image: ["image url", "image", "photo url", "photo", "picture", "card image"],
  notes: ["notes", "note", "comments"]
};

const FUZZY = {
  player: [/\bplayer\b/i, /\bathlete\b/i, /\bsubject\b/i, /\bfull\b.*\bname\b/i],
  firstName: [/^first/i, /\bfirst\b.*\bname\b/i],
  lastName: [/^last/i, /\blast\b.*\bname\b/i, /\bsurname\b/i],
  year: [/\byear\b/i, /\bseason\b/i],
  rookie: [/\brookie\b/i, /\brc\b/i],
  set: [/\bset\b/i, /\bproduct\b/i, /\bbrand\b/i],
  cardType: [/\btype\b/i, /\bsubset\b/i, /\binsert\b/i, /^base$/i],
  cardNumber: [/card.*(number|num|no|#)/i, /^\s*number\s*$/i],
  quantity: [/\bqty\b/i, /\bquantity\b/i, /\bcopies\b/i, /\bowned\b/i],
  purchasePrice: [/purchase.*(price|cost)/i, /price.*paid/i],
  value: [/market.*value/i, /current.*value/i, /estimated.*value/i],
  image: [/\bimage\b/i, /\bphoto\b/i, /\bpicture\b/i],
  notes: [/\bnotes?\b/i, /\bcomments?\b/i]
};

let rows = [];
let mapping = {};
let imageManifest = {};
let autoImageCache = {};
let imageObserver = null;
const queuedImageKeys = new Set();
const imageLookupQueue = [];
let activeImageBatches = 0;
let imageProviderReady = false;
let imageProviderBlocked = false;
let imagesFoundThisSession = 0;
let imagesMissedThisSession = 0;
let customImageIndex = {};
let currentPage = 1;
let pageSize = 250;
let currentPageRows = [];
let activeDetailIndex = null;
let customEditorOpen = false;
let marketGridSummaries = {};
let marketSyncStatus = {};
let marketPollTimer = null;

const $ = (id) => document.getElementById(id);
const norm = (s) => String(s ?? "")
  .trim()
  .toLowerCase()
  .replace(/[’']/g, "")
  .replace(/[()]/g, "")
  .replace(/\s+/g, " ");

const escapeHtml = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function mapHeaders(headers) {
  const result = {};
  const normalized = headers.map(h => ({ original: h, normalized: norm(h) }));

  for (const [key, aliases] of Object.entries(ALIASES)) {
    const exact = normalized.find(h => aliases.map(norm).includes(h.normalized));
    if (exact) {
      result[key] = exact.original;
      continue;
    }

    const patterns = FUZZY[key] || [];
    const fuzzy = normalized.find(h => patterns.some(p => p.test(h.original)));
    result[key] = fuzzy ? fuzzy.original : "";
  }

  return result;
}

// v8: the collection sheet has a known fixed layout.
// Use column position as the source of truth instead of guessing from headers.
function applyKnownColumnLayout(headers, detected) {
  return {
    ...detected,
    firstName: headers[0] || detected.firstName || "",   // A
    lastName: headers[1] || detected.lastName || "",     // B
    year: headers[2] || detected.year || "",             // C
    rookie: headers[3] || detected.rookie || "",         // D
    set: headers[4] || detected.set || "",                // E = Brand
    cardType: headers[5] || detected.cardType || "",      // F = Type
    cardNumber: headers[6] || detected.cardNumber || "",  // G = Number
    quantity: headers[7] || detected.quantity || "",      // H = Owned
    notes: headers[14] || detected.notes || ""            // O = Notes
  };
}

function field(row, key) {
  const header = mapping[key];
  return header ? String(row[header] ?? "").trim() : "";
}

function fullName(row) {
  const explicit = field(row, "player");
  if (explicit) return explicit;

  const first = field(row, "firstName");
  const last = field(row, "lastName");
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || "Unknown Player";
}

// The spreadsheet lists a player's name once, then leaves columns A/B blank
// for the following cards belonging to that player. Carry the most recent
// nonblank first and last names downward so every card row has a player.
function inheritPlayerNames(sourceRows) {
  const firstHeader = mapping.firstName;
  const lastHeader = mapping.lastName;
  const playerHeader = mapping.player;

  let previousFirst = "";
  let previousLast = "";
  let previousPlayer = "";

  return sourceRows.map(originalRow => {
    const row = { ...originalRow };

    if (playerHeader) {
      const currentPlayer = String(row[playerHeader] ?? "").trim();
      if (currentPlayer) {
        previousPlayer = currentPlayer;
      } else if (previousPlayer) {
        row[playerHeader] = previousPlayer;
      }
    }

    if (firstHeader) {
      const currentFirst = String(row[firstHeader] ?? "").trim();
      if (currentFirst) {
        previousFirst = currentFirst;
      } else if (previousFirst) {
        row[firstHeader] = previousFirst;
      }
    }

    if (lastHeader) {
      const currentLast = String(row[lastHeader] ?? "").trim();
      if (currentLast) {
        previousLast = currentLast;
      } else if (previousLast) {
        row[lastHeader] = previousLast;
      }
    }

    return row;
  });
}

function yesNoIsTrue(value) {
  const v = norm(value);
  return ["y", "yes", "true", "1", "rc"].includes(v);
}

function isRookie(row) {
  return yesNoIsTrue(field(row, "rookie"));
}

function moneyNumber(value) {
  const n = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  const n = typeof value === "number" ? value : moneyNumber(value);
  return n
    ? new Intl.NumberFormat("en-US", {
        style: "currency", currency: "USD", maximumFractionDigits: 0
      }).format(n)
    : "—";
}

function quantity(row) {
  const q = parseInt(field(row, "quantity"), 10);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

function titleFor(row) {
  return fullName(row);
}

function brandFor(row) {
  return field(row, "set");
}

function cardTypeFor(row) {
  return field(row, "cardType");
}

function cardQuery(row) {
  return [
    field(row, "year"),
    fullName(row),
    brandFor(row),
    cardTypeFor(row),
    field(row, "cardNumber"),
    isRookie(row) ? "Rookie" : ""
  ].filter(Boolean).join(" ");
}

function cardKey(row) {
  return [
    field(row, "year"),
    brandFor(row),
    fullName(row),
    field(row, "cardNumber"),
    cardTypeFor(row),
    isRookie(row) ? "rookie" : ""
  ].map(v => norm(v)).join("|");
}

function marketKey(row) {
  return `${cardKey(row)}|${norm(field(row, "notes"))}`;
}

function priceOrNaN(value) {
  return value !== null && value !== undefined && value !== "" && Number(value) > 0
    ? Number(value) : NaN;
}

function loadStoredImageCache() {
  try {
    const raw = localStorage.getItem(CONFIG.imageCacheStorageKey);
    autoImageCache = raw ? JSON.parse(raw) : {};
  } catch {
    autoImageCache = {};
  }
}

function saveStoredImageCache() {
  try {
    localStorage.setItem(CONFIG.imageCacheStorageKey, JSON.stringify(autoImageCache));
  } catch {
    // ignore storage errors
  }
}

function getCachedAutoImage(key) {
  const item = autoImageCache[key];
  if (item && typeof item.imageUrl === "string" && item.imageUrl) return item.imageUrl;
  return "";
}

function getCachedAutoImageData(key) {
  const item = autoImageCache[key];
  return item && item.imageUrl ? item : null;
}

function imageLookupRecentlyFailed(key) {
  const item = autoImageCache[key];
  if (!item || item.imageUrl) return false;
  const retryAfter = Number(item.retryAfter || 0);
  return retryAfter > Date.now();
}

function setCachedAutoImage(key, payload) {
  autoImageCache[key] = {
    imageUrl: payload.imageUrl || "",
    fallbackImageUrl: payload.fallbackImageUrl || "",
    originalImageUrl: payload.originalImageUrl || "",
    sourcePage: payload.sourcePage || "",
    source: payload.source || "",
    matchTitle: payload.matchTitle || "",
    matchScore: payload.matchScore || 0,
    cachedAt: new Date().toISOString(),
    retryAfter: 0
  };
  saveStoredImageCache();
}

function setCachedAutoImageMiss(key, hours = 12) {
  autoImageCache[key] = {
    imageUrl: "",
    sourcePage: "",
    source: "",
    cachedAt: new Date().toISOString(),
    retryAfter: Date.now() + hours * 60 * 60 * 1000
  };
  saveStoredImageCache();
}

function customImageDataFor(row) {
  const key = cardKey(row);
  const meta = customImageIndex[key];
  if (!meta) return null;

  const params = new URLSearchParams({
    key,
    v: String(meta.version || meta.updatedAt || "")
  });

  return {
    imageUrl: `${CONFIG.customImageEndpoint}?${params.toString()}`,
    fallbackImageUrl: "",
    source: "My photo",
    isCustom: true
  };
}

function imageDataFor(row) {
  // A user-uploaded custom image always wins.
  const custom = customImageDataFor(row);
  if (custom) return custom;

  const sheetUrl = field(row, "image");
  if (sheetUrl && /^https?:\/\//i.test(sheetUrl)) {
    return { imageUrl: sheetUrl, fallbackImageUrl: "" };
  }

  const manifest = imageManifest[cardKey(row)];
  if (typeof manifest === "string" && /^https?:\/\//i.test(manifest)) {
    return { imageUrl: manifest, fallbackImageUrl: "" };
  }
  if (manifest && /^https?:\/\//i.test(manifest.url || "")) {
    return { imageUrl: manifest.url, fallbackImageUrl: "" };
  }

  return getCachedAutoImageData(cardKey(row));
}

function imageUrlFor(row) {
  return imageDataFor(row)?.imageUrl || "";
}

function imageTagHtml(imageData, alt, detail = false) {
  const data = typeof imageData === "string"
    ? { imageUrl: imageData, fallbackImageUrl: "" }
    : imageData;

  const url = data?.imageUrl || "";
  const fallback = data?.fallbackImageUrl || "";
  const klass = detail ? "detail-image-tag" : "card-image";

  if (!url) return "";

  const fallbackAttr = fallback
    ? ` data-fallback="${escapeHtml(fallback)}"`
    : "";

  return `<img class="${klass}"
      src="${escapeHtml(url)}"
      alt="${alt}"
      loading="lazy"
      referrerpolicy="no-referrer"${fallbackAttr}
      onerror="handleCardImageError(this)">`;
}

window.handleCardImageError = function(img) {
  const fallback = img.dataset.fallback || "";
  if (fallback && img.src !== fallback) {
    img.dataset.fallback = "";
    img.src = fallback;
    return;
  }

  const parent = img.parentElement;
  if (parent) {
    parent.innerHTML = '<div class="card-placeholder"><strong>?</strong></div>';
  }
};

function placeholderHtml(row, realIndex) {
  return `<div class="card-placeholder auto-image"
      data-index="${realIndex}"
      data-key="${escapeHtml(cardKey(row))}">
      <strong>${escapeHtml(initials(titleFor(row)))}</strong>
    </div>`;
}

function imageHtml(row, realIndex, detail=false) {
  const data = imageDataFor(row);
  const alt = escapeHtml(cardQuery(row) || titleFor(row));

  if (data?.imageUrl) {
    return imageTagHtml(data, alt, detail);
  }

  return placeholderHtml(row, realIndex);
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0,2)
    .map(x => x[0]).join("").toUpperCase() || "FC";
}

function metaLine(row) {
  return [field(row, "year"), brandFor(row)].filter(Boolean).join(" · ");
}

function subtitle(row) {
  const bits = [];
  if (isRookie(row)) bits.push("RC");
  if (cardTypeFor(row)) bits.push(cardTypeFor(row));
  if (field(row, "cardNumber")) bits.push(field(row, "cardNumber"));
  return bits.join(" · ");
}

function searchable(row) {
  return Object.values(row).join(" ").toLowerCase();
}

function filteredRows() {
  let filtered = [...rows];
  if(unconfirmedOnly) filtered=filtered.filter(isUnconfirmed);
  if(watchlistOnly) filtered=filtered.filter(r=>watchlist.has(marketKey(r)));
  const q = norm($("search").value);
  const year = $("year-filter").value;

  if (q) filtered = filtered.filter(r => searchable(r).includes(q));
  if (year) filtered = filtered.filter(r => field(r, "year") === year);

  switch ($("sort").value) {
    case "player-asc":
      filtered.sort((a,b) => titleFor(a).localeCompare(titleFor(b)));
      break;
    case "year-desc":
      filtered.sort((a,b) => Number(field(b,"year")) - Number(field(a,"year")));
      break;
    case "year-asc":
      filtered.sort((a,b) => Number(field(a,"year")) - Number(field(b,"year")));
      break;
    case "value-desc":
      filtered.sort((a,b) => {
        const av = priceOrNaN(marketGridSummaries[marketKey(a)]?.ungraded);
        const bv = priceOrNaN(marketGridSummaries[marketKey(b)]?.ungraded);
        const aValid = Number.isFinite(av);
        const bValid = Number.isFinite(bv);

        if (aValid && bValid) return bv - av;
        if (bValid) return 1;
        if (aValid) return -1;
        return 0;
      });
      break;
    case "value-asc":
      filtered.sort((a,b) => {
        const av = priceOrNaN(marketGridSummaries[marketKey(a)]?.ungraded);
        const bv = priceOrNaN(marketGridSummaries[marketKey(b)]?.ungraded);
        const aValid = Number.isFinite(av);
        const bValid = Number.isFinite(bv);

        if (aValid && bValid) return av - bv;
        if (bValid) return 1;
        if (aValid) return -1;
        return 0;
      });
      break;
  }

  return filtered;
}

function paginationItems(totalPages, page) {
  if (totalPages <= 9) {
    return Array.from({length: totalPages}, (_, i) => i + 1);
  }

  const pages = new Set([1, totalPages]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p > 1 && p < totalPages) pages.add(p);
  }

  const sorted = [...pages].sort((a,b) => a - b);
  const items = [];

  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push("…");
    items.push(p);
  });

  return items;
}

function renderPagination(totalPages, totalEntries) {
  const build = () => {
    if (totalPages <= 1) return "";

    const items = paginationItems(totalPages, currentPage);

    return `
      <button class="page-button" data-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""}>‹</button>
      ${items.map(item => item === "…"
        ? '<span class="page-ellipsis">…</span>'
        : `<button class="page-button ${item === currentPage ? "active" : ""}" data-page="${item}">${item}</button>`
      ).join("")}
      <button class="page-button" data-page="${currentPage + 1}" ${currentPage >= totalPages ? "disabled" : ""}>›</button>
      <span class="page-summary">Page ${currentPage.toLocaleString()} of ${totalPages.toLocaleString()}</span>
    `;
  };

  ["pagination-top", "pagination-bottom"].forEach(id => {
    const nav = $(id);
    nav.innerHTML = build();

    nav.querySelectorAll(".page-button[data-page]").forEach(button => {
      button.addEventListener("click", () => {
        if (button.disabled) return;
        currentPage = Number(button.dataset.page);
        render();
        document.querySelector(".controls")?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      });
    });
  });
}

function compactMarketValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 10 ? 2 : 0,
    maximumFractionDigits: n < 100 ? 2 : 0
  }).format(n);
}

function gridMarketHtml(summary,key) {
  const data=summary||{};
  const manual=manualGradeEntries[key];const selectedPrice=manual?.prices?.[manual.selectedGrade];const hasGrade=manual?.selectedGrade&&typeof selectedPrice==='number';
  return `<div class="grid-price-pair"><div><div class="card-market-heading">Ungraded value</div><strong class="card-market-price">${compactMarketValue(data.ungraded)}</strong></div>${hasGrade?`<div><div class="card-market-heading">${escapeHtml(manual.selectedGrade==='PSA 10'?'PSA 10':'Grade '+manual.selectedGrade)}${manual.applyToCollection?' · Total':''}</div><strong class="card-market-price">${compactMarketValue(selectedPrice)}</strong></div>`:''}</div><div class="market-small-label">${data.state === "review" ? "Match needs review" : data.checkedAt ? `Checked ${new Date(data.checkedAt).toLocaleDateString()}` : "Awaiting sync"}</div>`;
}

function applyGridMarketSummaries() {
  document.querySelectorAll("[data-grid-market-key]").forEach(node => {
    const key = node.dataset.gridMarketKey || "";
    node.innerHTML = gridMarketHtml(marketGridSummaries[key],key);
  });
}

function setMarketProviderStatus(state, detail = "") {
  const pill = $("market-sync-pill");
  const text = $("market-sync-text");
  const line = $("market-status-line");

  if (!pill || !text || !line) return;

  pill.classList.remove("online", "error", "searching");

  if (state === "connected") {
    pill.classList.add("online");
    text.textContent = "Market ready";
  } else if (state === "searching") {
    pill.classList.add("searching");
    text.textContent = "Market syncing";
  } else if (state === "error") {
    pill.classList.add("error");
    text.textContent = "Market offline";
  } else {
    text.textContent = "Market checking";
  }

  if (detail) line.textContent = detail;
}

function marketDateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function renderMarketSyncStatus() {
  const s=marketSyncStatus||{}; const button=$("market-sync-btn");
  if(button){button.disabled=Boolean(s.running);button.textContent=s.running?"Syncing…":"Sync Market";}
  $("market-progress-wrap")?.classList.toggle("hidden",!s.running);
  const total=Number(s.totalRows||rows.length||0), valued=Number(s.valuedRows||0), review=Number(s.unresolvedRows||0), due=Number(s.dueRows||0);
  if($("market-progress-bar"))$("market-progress-bar").style.width=`${total ? Math.min(100,100*Number(s.matchedRows||0)/total):0}%`;
  if($("market-progress-detail"))$("market-progress-detail").textContent=`${Number(s.priceIdsProcessed||0)} processed this batch · ${Number(s.apiCallsThisRun||0)} API requests`;
  const deferred=Number(s.transientDeferred||0);
  const detail=!s.configured?"Add SPORTSCARDSPRO_API_TOKEN to production Functions, then deploy v31.":s.error?s.error:s.running?"Updating SportsCardsPro prices. You can close this page.":`${valued.toLocaleString()} of ${total.toLocaleString()} rows valued · ${review.toLocaleString()} need review · ${due.toLocaleString()} due${deferred?` · ${deferred.toLocaleString()} temporary ${deferred===1?'request':'requests'} deferred`:''}${s.phase==='partial'?' · Automatically resumes within ten minutes':''}`;
  setMarketProviderStatus(!s.configured||s.error?"error":s.running?"syncing":"connected",detail);
}
async function loadPersistentMarketIndex({ rerender = false } = {}) {
  try {
    const response = await fetch(
      `${CONFIG.marketIndexEndpoint}?ts=${Date.now()}`,
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Market database returned ${response.status}.`);
    }

    marketGridSummaries = payload.summaries || {};
    marketSyncStatus = payload.status || {};

    renderMarketSyncStatus();
    updateStats();
    if(activeDetailIndex !== null && $("card-dialog")?.open)loadMarketData(activeDetailIndex);

    if (rerender) render();

    if (marketSyncStatus.running || marketSyncStatus.phase === "partial") {
      scheduleMarketPoll();
    } else if (marketPollTimer) {
      clearTimeout(marketPollTimer);
      marketPollTimer = null;
    }

    return payload;
  } catch (error) {
    setMarketProviderStatus(
      "error",
      `Market database unavailable: ${error.message}`
    );
    return null;
  }
}

function scheduleMarketPoll() {
  if (marketPollTimer) clearTimeout(marketPollTimer);

  marketPollTimer = setTimeout(async () => {
    await loadPersistentMarketIndex({ rerender: true });
  }, CONFIG.marketPollMs);
}

async function startMarketSync() {
  const password = window.prompt("Enter the catalog admin password to start the market sync:");
  if (!password) return;

  const button = $("market-sync-btn");
  if (button) {
    button.disabled = true;
    button.textContent = "Starting…";
  }

  marketSyncStatus = {
    ...marketSyncStatus,
    configured: true,
    running: false,
    phase: "queued",
    error: ""
  };

  renderMarketSyncStatus();

  try {
    const response = await fetch(CONFIG.marketSyncEndpoint, {
      method: "POST",
      headers: {
        "X-Catalog-Admin": password
      }
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      throw new Error("Incorrect catalog admin password.");
    }

    if (!response.ok && response.status !== 202) {
      throw new Error(
        payload.error ||
        payload.message ||
        `Could not start sync (${response.status}).`
      );
    }

    // Keep the same password available for custom-image editing during this tab.
    sessionStorage.setItem("football-card-admin-password", password);

    marketSyncStatus = payload.status || {
      ...marketSyncStatus,
      running: true,
      phase: "queued"
    };

    renderMarketSyncStatus();
    scheduleMarketPoll();
  } catch (error) {
    marketSyncStatus = {
      ...marketSyncStatus,
      configured: true,
      running: false,
      phase: "error",
      error: error.message
    };
    renderMarketSyncStatus();
  } finally {
    if (button && !marketSyncStatus.running && marketSyncStatus.phase !== "queued") {
      button.disabled = false;
      button.textContent = "Sync Market";
    }
  }
}

function render() {
  const filtered = filteredRows();
  pageSize = Number($("page-size")?.value || CONFIG.defaultPageSize);

  const totalEntries = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalEntries);
  currentPageRows = filtered.slice(startIndex, endIndex);

  const totalCards = filtered.reduce((sum,r)=>sum+quantity(r),0);

  $("results-count").textContent = totalEntries
    ? `${totalCards.toLocaleString()} cards · showing ${(startIndex + 1).toLocaleString()}–${endIndex.toLocaleString()} of ${totalEntries.toLocaleString()} catalog entries`
    : "0 cards";

  $("catalog").innerHTML = currentPageRows.map((row) => {
    const realIndex = rows.indexOf(row);
    const sub = subtitle(row);
    const notes = String(field(row, "notes") || "").trim();
    return `
      <article class="card card-clickable" data-index="${realIndex}" tabindex="0" role="button" aria-label="View details for ${escapeHtml(titleFor(row))}">
        <div class="card-image-wrap"><button class="favorite-button ${watchlist.has(marketKey(row))?'selected':''}" data-favorite="${realIndex}" aria-label="Toggle watchlist for ${escapeHtml(titleFor(row))}" aria-pressed="${watchlist.has(marketKey(row))}">${watchlist.has(marketKey(row))?'♥':'♡'}</button>
          ${imageHtml(row, realIndex, false)}
          ${isRookie(row) ? '<span class="grade-badge">RC</span>' : ""}
        </div>
        <div class="card-body">
          ${metaLine(row) ? `<div class="card-meta">${escapeHtml(metaLine(row))}</div>` : ""}
          <h3 class="card-name">${escapeHtml(titleFor(row))}</h3>
          ${sub || notes ? `<div class="card-subtitle card-description"><span class="card-model">${escapeHtml(sub)}</span>${notes ? `<span class="card-notes" title="${escapeHtml(notes)}">${escapeHtml(notes)}</span>` : ""}</div>` : ""}
          <div class="card-bottom card-bottom-market">
            <div class="card-market-block"
              data-grid-market-key="${escapeHtml(marketKey(row))}">
              ${gridMarketHtml(marketGridSummaries[marketKey(row)],marketKey(row))}
            </div>
          </div>
        </div>
      </article>`;
  }).join("");

  $("empty-state").classList.toggle("hidden", totalEntries > 0);

  document.querySelectorAll(".card-clickable").forEach(cardEl => {
    const openCard = event => {if(event.target.closest("[data-favorite]"))return;openDetails(Number(cardEl.dataset.index));};
    cardEl.addEventListener("click", openCard);
    cardEl.addEventListener("keydown", (event) => {
      if(event.target.closest("[data-favorite]"))return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCard(event);
      }
    });
  });

  document.querySelectorAll("[data-favorite]").forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();toggleFavorite(Number(button.dataset.favorite));}));
  $("watchlist-count").textContent=watchlist.size;
  $("unconfirmed-count").textContent=rows.filter(isUnconfirmed).length;
  renderPagination(totalPages, totalEntries);
  setupAutoImageLoading();
}
function setOptions(id, values, label) {
  const el = $(id);
  const current = el.value;
  const sorted = [...new Set(values.filter(Boolean))].sort((a,b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true })
  );
  el.innerHTML = `<option value="">${label}</option>` +
    sorted.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (sorted.includes(current)) el.value = current;
}

function updateStats() {
  const cardCount = rows.reduce((sum,r) => sum + quantity(r), 0);

  let totalValue = 0;
  let valuedCopies = 0;

  for (const row of rows) {
    const manual=manualGradeEntries[marketKey(row)];
    const selected=manual?.prices?.[manual.selectedGrade];
    const rawValue = manual?.applyToCollection&&typeof selected==='number'?selected:priceOrNaN(marketGridSummaries[marketKey(row)]?.ungraded);
    if (!Number.isFinite(rawValue)) continue;

    const qty = quantity(row);
    totalValue += rawValue * qty;
    valuedCopies += qty;
  }

  const totalCost = rows.reduce((sum,r) =>
    sum + moneyNumber(field(r,"purchasePrice")) * quantity(r), 0);

  $("stat-cards").textContent = cardCount.toLocaleString();
  $("stat-value").textContent = manualGradesReady?(valuedCopies?money(totalValue):"—"):"Unavailable";
  $("stat-cost").textContent = totalCost ? money(totalCost) : "—";

  const valueCard = document.getElementById("stat-value")?.closest(".stat-card");
  const costCard = document.getElementById("stat-cost")?.closest(".stat-card");

  if (valueCard) {
    valueCard.style.display = "";
    valueCard.title = valuedCopies
      ? `Based on ${valuedCopies.toLocaleString()} valued card copies`
      : "Market values have not been synced yet";
  }

  if (costCard) costCard.style.display = mapping.purchasePrice ? "" : "none";

  const stats = document.querySelector(".stats");
  if (stats) {
    const visibleCards = Array.from(stats.querySelectorAll(".stat-card"))
      .filter(card => card.style.display !== "none").length;
    stats.style.gridTemplateColumns =
      `repeat(${Math.max(1, visibleCards)}, 1fr)`;
  }
}

function updatePlaceholdersForKey(key, imageData) {
  const url = imageData?.imageUrl || "";
  if (!url) return;

  const alt = escapeHtml(key);
  document.querySelectorAll(`.auto-image[data-key="${CSS.escape(key)}"]`).forEach(node => {
    node.outerHTML = imageTagHtml(imageData, alt, false);
  });
}

function setImageProviderStatus(state, detail = "") {
  const pill = $("image-sync-pill");
  const text = $("image-sync-text");
  const line = $("image-status-line");

  pill.classList.remove("online", "error", "searching");

  if (state === "connected") {
    pill.classList.add("online");
    text.textContent = "Images connected";
  } else if (state === "searching") {
    pill.classList.add("searching");
    text.textContent = "Finding images";
  } else if (state === "error") {
    pill.classList.add("error");
    text.textContent = "Images offline";
  } else if (state === "checking") {
    text.textContent = "Images checking";
  } else {
    text.textContent = "Images checking";
  }

  if (detail) line.textContent = detail;
}

async function checkImageProvider() {
  try {
    const response = await fetch(`${CONFIG.imageBatchEndpoint}?health=1`, {
      cache: "no-store"
    });
    const payload = await response.json();

    if (!response.ok || !payload.configured) {
      imageProviderReady = false;
      imageProviderBlocked = true;

      const reason = payload.code === "SERPER_NOT_CONFIGURED"
        ? "Image search is not connected: Netlify cannot see SERPER_API_KEY."
        : `Image search is not connected: ${payload.error || `HTTP ${response.status}`}`;

      setImageProviderStatus("error", reason);
      return false;
    }

    imageProviderReady = true;
    imageProviderBlocked = false;
    setImageProviderStatus(
      "checking",
      "Image API key detected. Testing the first real card searches…"
    );
    processImageQueue();
    return true;
  } catch (error) {
    imageProviderReady = false;
    imageProviderBlocked = true;
    setImageProviderStatus(
      "error",
      `Image search connection failed: ${error.message}`
    );
    return false;
  }
}

function cardPayload(row) {
  return {
    key: cardKey(row),
    player: fullName(row),
    year: field(row, "year"),
    brand: brandFor(row),
    type: cardTypeFor(row),
    number: field(row, "cardNumber"),
    rookie: isRookie(row) ? "Y" : "N",
    notes: field(row, "notes")
  };
}

function enqueueAutoImage(row, priority = false) {
  const key = cardKey(row);
  if (!key) return;

  const existing = imageDataFor(row);
  if (existing?.imageUrl) {
    updatePlaceholdersForKey(key, existing);
    return;
  }

  if (imageLookupRecentlyFailed(key)) return;
  if (queuedImageKeys.has(key)) return;

  queuedImageKeys.add(key);

  if (priority) imageLookupQueue.unshift(row);
  else imageLookupQueue.push(row);

  processImageQueue();
}

async function runImageBatch(batch) {
  const cards = batch.map(cardPayload);

  try {
    const response = await fetch(CONFIG.imageBatchEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards })
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      imageProviderBlocked = true;

      if (payload.code === "SERPER_NOT_CONFIGURED") {
        imageProviderReady = false;
        setImageProviderStatus(
          "error",
          "Image search is not connected: Netlify cannot see SERPER_API_KEY."
        );
      } else {
        setImageProviderStatus(
          "error",
          `Image search stopped: ${payload.error || `HTTP ${response.status}`}`
        );
      }
      return;
    }

    imageProviderReady = true;
    imageProviderBlocked = false;

    for (const result of payload.results || []) {
      const key = result.key;
      if (!key) continue;

      if (result.imageUrl) {
        setCachedAutoImage(key, result);
        updatePlaceholdersForKey(key, result);
        imagesFoundThisSession += 1;
      } else {
        setCachedAutoImageMiss(key, 6);
        imagesMissedThisSession += 1;
      }
    }

    const providerErrors = payload.providerErrors || [];
    if (providerErrors.length) {
      imageProviderBlocked = true;
      setImageProviderStatus(
        "error",
        `Image provider error: ${providerErrors[0]}`
      );
    } else {
      imageProviderBlocked = false;
      setImageProviderStatus(
        "connected",
        `Image search connected · ${imagesFoundThisSession} found · ${imagesMissedThisSession} unmatched · ${imageLookupQueue.length} queued`
      );
    }
  } catch (error) {
    setImageProviderStatus(
      "error",
      `Image batch failed: ${error.message}`
    );
  }
}

function processImageQueue() {
  if (!imageProviderReady || imageProviderBlocked) return;

  while (
    activeImageBatches < CONFIG.imageBatchConcurrency &&
    imageLookupQueue.length
  ) {
    const batch = [];

    while (
      batch.length < CONFIG.imageBatchSize &&
      imageLookupQueue.length
    ) {
      const row = imageLookupQueue.shift();
      const key = cardKey(row);
      queuedImageKeys.delete(key);

      if (!key || imageDataFor(row)?.imageUrl || imageLookupRecentlyFailed(key)) {
        continue;
      }

      batch.push(row);
    }

    if (!batch.length) continue;

    activeImageBatches += 1;
    setImageProviderStatus(
      "searching",
      `Searching for ${batch.length} card image${batch.length === 1 ? "" : "s"}…`
    );

    runImageBatch(batch)
      .finally(() => {
        activeImageBatches -= 1;
        processImageQueue();
      });
  }
}

function setupAutoImageLoading() {
  if (imageObserver) imageObserver.disconnect();

  // v13: put the top of the spreadsheet into the queue FIRST. This makes
  // image discovery deterministic instead of letting restored scroll position
  // or IntersectionObserver timing jump lower rows ahead of the catalog start.
  currentPageRows
    .slice(0, CONFIG.initialImageLookahead)
    .forEach(row => enqueueAutoImage(row));

  imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      const index = Number(entry.target.dataset.index);
      const row = rows[index];
      if (row) enqueueAutoImage(row);

      imageObserver.unobserve(entry.target);
    });
  }, { rootMargin: "800px 0px" });

  document.querySelectorAll(".auto-image[data-index]").forEach(node => {
    imageObserver.observe(node);
  });
}
async function loadCustomImageIndex() {
  try {
    const response = await fetch(`${CONFIG.customImageEndpoint}?index=1&ts=${Date.now()}`, {
      cache: "no-store"
    });
    if (!response.ok) return {};
    const payload = await response.json();
    return payload.index || {};
  } catch {
    return {};
  }
}

function adminPassword() {
  return sessionStorage.getItem("football-card-admin-password") || "";
}

function requestAdminPassword() {
  const existing = adminPassword();
  if (existing) return existing;

  const value = window.prompt("Enter the catalog admin password:");
  if (!value) return "";

  sessionStorage.setItem("football-card-admin-password", value);
  return value;
}

async function imageElementFromFile(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

async function canvasBlob(canvas, quality) {
  return new Promise(resolve => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

async function prepareCustomImage(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Please choose or paste an image.");
  }

  const source = await imageElementFromFile(file);
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, width, height);

  if (source.close) source.close();

  let blob = await canvasBlob(canvas, .88);

  if (blob && blob.size > 3_500_000) {
    blob = await canvasBlob(canvas, .72);
  }

  if (!blob) throw new Error("Could not prepare the image for upload.");
  if (blob.size > 4_500_000) {
    throw new Error("The image is still too large after resizing.");
  }

  return new File([blob], "card-photo.jpg", { type: "image/jpeg" });
}

function setUploadStatus(message, state = "") {
  const el = $("custom-upload-status");
  if (!el) return;

  el.textContent = message;
  el.className = `upload-status ${state}`.trim();
}

async function uploadCustomImage(index, originalFile) {
  const row = rows[index];
  if (!row) return;

  const password = requestAdminPassword();
  if (!password) return;

  try {
    setUploadStatus("Preparing image…");
    const file = await prepareCustomImage(originalFile);

    setUploadStatus("Saving permanently…");

    const form = new FormData();
    form.append("file", file);
    form.append("key", cardKey(row));
    form.append("password", password);

    const response = await fetch(CONFIG.customImageEndpoint, {
      method: "POST",
      body: form
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      sessionStorage.removeItem("football-card-admin-password");
      throw new Error("Incorrect admin password.");
    }

    if (!response.ok) {
      throw new Error(payload.error || `Upload failed (${response.status}).`);
    }

    customImageIndex[cardKey(row)] = payload.meta;
    setUploadStatus("Saved. This photo will now appear on every device.", "success");

    render();
    renderDetailContent(index);
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
}

async function removeCustomImage(index) {
  const row = rows[index];
  if (!row) return;

  const password = requestAdminPassword();
  if (!password) return;

  if (!window.confirm("Remove your custom image and go back to the automatically found image?")) {
    return;
  }

  const response = await fetch(CONFIG.customImageEndpoint, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: cardKey(row),
      password
    })
  });

  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    sessionStorage.removeItem("football-card-admin-password");
    window.alert("Incorrect admin password.");
    return;
  }

  if (!response.ok) {
    window.alert(payload.error || "Could not remove the image.");
    return;
  }

  delete customImageIndex[cardKey(row)];
  render();
  renderDetailContent(index);
}

function openCustomImageEditor(index) {
  customEditorOpen = true;
  const panel = $("custom-image-panel");
  if (!panel) return;

  panel.classList.remove("hidden");
  $("custom-file-input")?.focus();
}

function attachCustomEditorEvents(index) {
  $("replace-image-btn")?.addEventListener("click", () => openCustomImageEditor(index));
  $("remove-custom-image-btn")?.addEventListener("click", () => removeCustomImage(index));

  const input = $("custom-file-input");
  const choose = $("choose-custom-image");
  const dropzone = $("custom-image-dropzone");

  choose?.addEventListener("click", () => input?.click());

  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) uploadCustomImage(index, file);
  });

  if (dropzone) {
    ["dragenter", "dragover"].forEach(type => {
      dropzone.addEventListener(type, event => {
        event.preventDefault();
        dropzone.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach(type => {
      dropzone.addEventListener(type, event => {
        event.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });

    dropzone.addEventListener("drop", event => {
      const file = [...(event.dataTransfer?.files || [])]
        .find(item => String(item.type || "").startsWith("image/"));

      if (file) uploadCustomImage(index, file);
    });
  }
}


function marketMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(String(value).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 10 ? 2 : 0,
    maximumFractionDigits: 2
  }).format(n);
}

function chartSvg(points) {
  const clean = (points || [])
    .map(s => ({
      ...s,
      timestamp: Date.parse(s.date),
      numericPrice: Number(
        s.numericPrice !== undefined && s.numericPrice !== null
          ? s.numericPrice
          : String(s.price || "").replace(/[$,]/g, "")
      )
    }))
    .filter(s => Number.isFinite(s.timestamp) && Number.isFinite(s.numericPrice))
    .sort((a,b) => a.timestamp - b.timestamp);

  if (clean.length < 2) {
    return `
      <div class="no-chart">
        <strong>Not enough historical data for a chart yet.</strong>
        <span>Weekly price snapshots will appear here.</span>
      </div>`;
  }

  const W = 780;
  const H = 245;
  const L = 58;
  const R = 22;
  const T = 18;
  const B = 40;
  const plotW = W - L - R;
  const plotH = H - T - B;

  const minX = clean[0].timestamp;
  const maxX = clean[clean.length - 1].timestamp;
  let minY = Math.min(...clean.map(s => s.numericPrice));
  let maxY = Math.max(...clean.map(s => s.numericPrice));

  if (minY === maxY) {
    minY = Math.max(0, minY * .75);
    maxY = maxY * 1.25 + .25;
  } else {
    const pad = (maxY - minY) * .14;
    minY = Math.max(0, minY - pad);
    maxY += pad;
  }

  const x = t => L + ((t - minX) / Math.max(1, maxX - minX)) * plotW;
  const y = p => T + (1 - ((p - minY) / Math.max(.001, maxY - minY))) * plotH;

  const xy = clean.map(s => [x(s.timestamp), y(s.numericPrice)]);
  const smoothPath = pts => {
    if (pts.length < 2) return "";
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const path = smoothPath(xy);
  const yTicks = Array.from({length: 4}, (_, i) => {
    const ratio = i / 3;
    const price = maxY - (maxY - minY) * ratio;
    const yy = T + plotH * ratio;
    return `
      <line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" class="chart-gridline"/>
      <text x="${L-10}" y="${yy+4}" class="chart-axis-label" text-anchor="end">${escapeHtml(marketMoney(price))}</text>`;
  }).join("");

  const firstDate = new Date(minX).toLocaleDateString(undefined, {month:"short", year:"numeric"});
  const midDate = new Date((minX+maxX)/2).toLocaleDateString(undefined, {month:"short", year:"2-digit"});
  const lastDate = new Date(maxX).toLocaleDateString(undefined, {month:"short", year:"numeric"});

  const latest = clean[clean.length - 1];
  const latestX = x(latest.timestamp);
  const latestY = y(latest.numericPrice);
  const latestLabel = marketMoney(latest.numericPrice);
  const latestLabelWidth = Math.max(68, latestLabel.length * 8 + 18);
  const latestLabelHeight = 24;
  const latestLabelX = Math.min(
    W - R - latestLabelWidth,
    Math.max(L + 4, latestX - latestLabelWidth - 14)
  );
  const latestLabelY = Math.max(T + 4, latestY - 32);

  const dots = clean.map((s, i) => {
    const cx = x(s.timestamp).toFixed(1);
    const cy = y(s.numericPrice).toFixed(1);
    if (i === clean.length - 1) {
      return `
        <circle cx="${cx}" cy="${cy}" r="10" class="chart-latest-halo"></circle>
        <circle cx="${cx}" cy="${cy}" r="5.6" class="chart-latest-dot">
          <title>${escapeHtml(`${s.date}: ${marketMoney(s.numericPrice)}`)}</title>
        </circle>`;
    }
    return `
      <circle cx="${cx}" cy="${cy}" r="3.5" class="chart-dot">
        <title>${escapeHtml(`${s.date}: ${marketMoney(s.numericPrice)}`)}</title>
      </circle>`;
  }).join("");

  const latestBadge = `
      <line x1="${(latestLabelX + latestLabelWidth).toFixed(1)}" y1="${(latestLabelY + latestLabelHeight/2).toFixed(1)}" x2="${(latestX - 8).toFixed(1)}" y2="${latestY.toFixed(1)}" class="chart-latest-connector"/>
      <rect x="${latestLabelX.toFixed(1)}" y="${latestLabelY.toFixed(1)}" width="${latestLabelWidth.toFixed(1)}" height="${latestLabelHeight}" rx="12" class="chart-latest-badge"/>
      <text x="${(latestLabelX + latestLabelWidth/2).toFixed(1)}" y="${(latestLabelY + 16).toFixed(1)}" text-anchor="middle" class="chart-latest-label">${escapeHtml(latestLabel)}</text>`;

  return `
    <svg class="sales-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historical card price chart">
      ${yTicks}
      <path d="${path}" class="chart-line"/>
      ${dots}
      ${latestBadge}
      <text x="${L}" y="${H-10}" class="chart-axis-label">${escapeHtml(firstDate)}</text>
      <text x="${W/2}" y="${H-10}" class="chart-axis-label" text-anchor="middle">${escapeHtml(midDate)}</text>
      <text x="${W-R}" y="${H-10}" class="chart-axis-label" text-anchor="end">${escapeHtml(lastDate)}</text>
    </svg>`;
}

function renderConfirmation(index){
 const panel=$('card-confirmation'),data=marketGridSummaries[marketKey(rows[index])]||{};
 panel.innerHTML='<details class="match-details"><summary>'+(data.id||data.manualId?'Card match':'Confirm this card')+'</summary><p class="market-small-label">Open a candidate to check its year, set, number and parallel, then save the correct product ID below.</p>'+ (data.candidates||[]).map(c=>{const query=[c.set,c.title].filter(Boolean).join(' ');return '<p class="candidate-row"><a target="_blank" rel="noopener" href="https://www.sportscardspro.com/search-products?type=prices&q='+encodeURIComponent(query)+'">'+escapeHtml(c.id)+' ↗</a> — '+escapeHtml(c.set)+' · '+escapeHtml(c.title)+'</p>';}).join('')+'<p class="market-small-label">Candidate links open a SportsCardsPro search for that card.</p><form id="confirm-card-form"><label>SportsCardsPro ID<input id="confirmed-product-id" type="text" inputmode="numeric" pattern="[0-9]{1,15}" required value="'+escapeHtml(data.manualId||data.id||'')+'" placeholder="e.g. 6116541"></label><button class="button primary" type="submit">Save card ID</button><p id="confirmation-status" role="status">'+(data.manualId?'Saved ID: '+escapeHtml(data.manualId):'')+'</p></form></details>';
 const form=$('confirm-card-form');form.onsubmit=async event=>{event.preventDefault();const password=requestAdminPassword();if(!password)return;const id=form.querySelector('input').value.trim();const status=form.querySelector('[role=status]'),button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';
 try{const r=await fetch('/.netlify/functions/confirm-card',{method:'POST',headers:{'content-type':'application/json','x-catalog-admin':password},body:JSON.stringify({key:marketKey(rows[index]),id})});const result=await r.json();if(!r.ok){if(r.status===401)sessionStorage.removeItem('football-card-admin-password');throw Error(result.error||'Could not save ID.');}const key=marketKey(rows[index]);const old=marketGridSummaries[key]||{};marketGridSummaries[key]={...old,manualId:id,...(old.id===id?{}:{id:'',ungraded:null,history:[],checkedAt:null,state:'pending',reason:'ID saved. Waiting for the next pricing batch.'})};status.textContent='Saved permanently. The next scheduled pricing batch will use this ID.';render();if(activeDetailIndex===index)loadMarketData(index);
 }catch(e){status.textContent=e.message;}finally{button.disabled=false;}};
}

const recentSalesState = new Map();
function recentSalesPanel(index) {
  const state = recentSalesState.get(index);
  if (!state) return '<p>Load recent ungraded sales through the previous Parse integration.</p><button class="button" onclick="loadRecentSales('+index+')">Load recent sales</button><p class="market-small-label">Uses Parse credits separately from your SportsCardsPro subscription.</p>';
  if (state.loading) return '<p>Loading recent sales…</p>';
  if (state.error) return '<p>'+escapeHtml(state.error)+'</p><button class="button" onclick="loadRecentSales('+index+')">Retry recent sales</button>';
  if (!state.sales.length) return '<p>No recent sales were returned for this card.</p>';
  return '<p class="market-small-label">SportsCardsPro via Parse · Check listing condition and variant before comparing.</p><div class="sales-list">'+state.sales.map(sale=>{
    const raw=String(sale.url||sale.link||'');
    let safe='';try{const u=new URL(raw);if(u.protocol==='https:'||u.protocol==='http:')safe=u.href;}catch{}
    const title=escapeHtml(sale.title||'Completed sale');
    const href=safe||'https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw='+encodeURIComponent(sale.title||'');
    return '<article class="sale-row compact-sale"><time>'+escapeHtml(String(sale.date||'').slice(0,10))+'</time><a class="sale-title-link" href="'+escapeHtml(href)+'" target="_blank" rel="noopener noreferrer" title="'+title+'">'+title+'<span class="sale-link-note">'+(safe?'View listing ↗':'Search sold listings ↗')+'</span></a><strong>'+escapeHtml(marketMoney(Number(sale.numericPrice??sale.price)))+'</strong></article>' ;
  }).join('')+'</div>';
}
async function loadRecentSales(index) {
  if(recentSalesState.get(index)?.loading)return;
  recentSalesState.set(index,{loading:true});
  const paint=()=>{if(activeDetailIndex===index){const target=document.getElementById('recent-sales-content');if(target)target.innerHTML=recentSalesPanel(index);}};
  paint();
  try {
    const row=rows[index];
    const query=new URLSearchParams({player:fullName(row),year:field(row,'year'),brand:brandFor(row),type:cardTypeFor(row),number:field(row,'cardNumber'),notes:field(row,'notes')||''});
    const response=await fetch('/.netlify/functions/card-market?'+query);
    const match=await response.json();
    if(!response.ok||!match.found||!match.cardId)throw new Error(match.message||'No confirmed sales match was found.');
    const result=await fetch('/.netlify/functions/card-market-sales?'+new URLSearchParams({cardId:match.cardId}));
    const payload=await result.json();
    if(!result.ok)throw new Error(payload.message||'Recent sales are unavailable.');
    recentSalesState.set(index,{sales:(payload.sales||[]).filter(s=>s.title&&Date.parse(s.date)&&Number(s.numericPrice??s.price)>0)});
  } catch(error) {recentSalesState.set(index,{error:error.message||'Recent sales could not be loaded.'});}
  paint();
}

function loadMarketData(index) {
  const row=rows[index],target=$("market-content");if(!row||!target)return;
  const data=marketGridSummaries[marketKey(row)]||{};
  const query=[field(row,"year"),brandFor(row),fullName(row),'#'+field(row,"cardNumber"),cardTypeFor(row),field(row,"notes")].filter(Boolean).join(' ');
  const link=data.url||`https://www.sportscardspro.com/search-products?q=${encodeURIComponent(query)}&type=prices`;
  const points=(data.history||[]).filter(p=>Date.parse(p.date)>=Date.now()-366*86400000);
  target.innerHTML=`<section class="market-panel"><div class="section-kicker">SPORTSCARDSPRO</div><h3>Ungraded market value</h3><div class="market-primary-value">${compactMarketValue(data.ungraded)}</div><p>${escapeHtml(data.reason||(!data.checkedAt?'Awaiting the first price sync.':'Current ungraded guide value.'))}</p><p class="market-small-label">${data.checkedAt?`Last checked ${escapeHtml(marketDateLabel(data.checkedAt))}`:''}${data.id?` · Product ID ${escapeHtml(data.id)}`:''}</p>${data.title?`<p>${escapeHtml(data.set)} · ${escapeHtml(data.title)}</p>`:''}<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${data.url?'View card on':'Find card on'} SportsCardsPro ↗</a></section>
  <section class="market-panel"><h3>Saved price history</h3>${points.length>1?chartSvg(points):'<p>History will build as prices are refreshed. Two snapshots are needed for a chart.</p>'}<p class="market-small-label">Weekly guide-value snapshots collected by this catalog. These are not individual sales. Recent sales below use a separate Parse integration.</p></section>
  <section class="market-panel recent-sales-section"><h3>Recent sales</h3><div id="recent-sales-content">${recentSalesPanel(index)}</div></section>
  `;
}

function renderDetailContent(index) {
  const row = rows[index];
  if (!row) return;

  activeDetailIndex = index;
  enqueueAutoImage(row, true);

  const q = encodeURIComponent(cardQuery(row));
  const googleImages = `https://www.google.com/search?tbm=isch&q=${q}`;
  const ebaySold = `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`;
  const hasCustom = Boolean(customImageIndex[cardKey(row)]);

  $("dialog-content").innerHTML = `
    <div class="market-detail">
      <aside class="market-card-column">
        <div class="market-card-image">${imageHtml(row, index, true)}</div>

        <div class="market-card-identity">
          ${metaLine(row) ? `<div class="eyebrow">${escapeHtml(metaLine(row))}</div>` : ""}
          <h2>${escapeHtml(titleFor(row))}</h2>
          ${subtitle(row) ? `<div class="detail-subtitle">${escapeHtml(subtitle(row))}</div>` : ""}
          ${String(field(row, "notes") || "").trim() ? `<p class="detail-notes">${escapeHtml(String(field(row, "notes")).trim())}</p>` : ""}
        </div>

        <div class="detail-actions compact-actions">
          <button class="primary" id="replace-image-btn" type="button">${hasCustom ? "Replace image" : "Use my image"}</button>
          ${hasCustom ? '<button class="danger" id="remove-custom-image-btn" type="button">Remove image</button>' : ""}
          <a href="${ebaySold}" target="_blank" rel="noopener">More eBay sales</a>
          <a href="${googleImages}" target="_blank" rel="noopener">Image search</a>
        </div>

        <section id="custom-image-panel" class="custom-image-panel ${customEditorOpen ? "" : "hidden"}">
          <h3>Permanent custom image</h3>
          <p>Paste an image with <strong>Ctrl+V</strong>, drag one here, or choose a file.</p>

          <div id="custom-image-dropzone" class="upload-dropzone">
            <div>
              <strong>Paste, drop, or choose an image</strong>
              <span>On a phone, choose a photo from your library.</span>
            </div>
          </div>

          <input id="custom-file-input" type="file" accept="image/*" class="sr-only">

          <div class="upload-buttons">
            <button id="choose-custom-image" class="button secondary" type="button">Choose Image</button>
          </div>

          <div id="custom-upload-status" class="upload-status"></div>
        </section>
      </aside>

      <main class="market-detail-main"><section id="card-confirmation" class="market-panel"></section><section id="manual-grades" class="market-panel"><h3>My graded prices</h3><p>Loading saved prices…</p></section>
        <div id="market-content">
          <p>Loading saved prices…</p>
        </div>
      </main>
    </div>`;

  renderConfirmation(index);
  loadManualGrades(index);
  attachCustomEditorEvents(index);
  loadMarketData(index);
}
function openDetails(index) {
  customEditorOpen = false;
  renderDetailContent(index);

  if (!$("card-dialog").open) {
    $("card-dialog").showModal();
  }
}

async function loadCards() {
  $("sync-text").textContent = "Connecting";
  $("sync-pill").classList.remove("online");
  $("status-line").textContent = "Connecting to Google Sheets…";
  $("error-state").classList.add("hidden");

  try {
    loadStoredImageCache();
    checkImageProvider();

    const [response, manifestResponse, customIndex, marketPayload] = await Promise.all([
      fetch(`${CONFIG.dataEndpoint}?ts=${Date.now()}`, { cache: "no-store" }),
      fetch(`${CONFIG.imageManifest}?ts=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      loadCustomImageIndex(),
      fetch(`${CONFIG.marketIndexEndpoint}?ts=${Date.now()}`, { cache: "no-store" })
        .then(async response => {
          const payload = await response.json().catch(() => ({}));
          return response.ok ? payload : { summaries: {}, status: { configured: false } };
        })
        .catch(() => ({ summaries: {}, status: { configured: false } }))
    ]);

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);

    imageManifest = (manifestResponse && manifestResponse.ok)
      ? await manifestResponse.json()
      : {};

    customImageIndex = customIndex || {};
    marketGridSummaries = marketPayload?.summaries || {};
    marketSyncStatus = marketPayload?.status || {};

    const sourceRows = payload.rows || [];
    if (!sourceRows.length) throw new Error("The sheet connected, but no card rows were found.");

    const headers = payload.headers || Object.keys(sourceRows[0] || {});
    mapping = applyKnownColumnLayout(headers, mapHeaders(headers));

    rows = inheritPlayerNames(sourceRows);

    await loadManualGradeIndex();
    updateStats();
    setOptions("year-filter", rows.map(r=>field(r,"year")), "All years");

    document.getElementById("team-filter").style.display = "none";
    document.getElementById("grade-filter").style.display = "none";

    render();
    renderMarketSyncStatus();
    if (marketSyncStatus.running || marketSyncStatus.phase === "queued") scheduleMarketPoll();

    $("sync-text").textContent = "Live";
    $("sync-pill").classList.add("online");
    $("status-line").textContent =
      `${rows.length.toLocaleString()} catalog entries loaded from your Google Sheet.`;
    $("last-updated").textContent = `Last refreshed ${new Date().toLocaleString()}`;

    console.log("Detected Sheet columns:", mapping);
    console.log("Sheet headers:", headers);
  } catch (err) {
    console.error(err);
    rows = [];
    $("catalog").innerHTML = "";
    $("sync-text").textContent = "Setup needed";
    $("status-line").textContent =
      "The website is ready; the Sheet connection needs to be enabled.";
    $("error-message").textContent = err.message;
    $("error-state").classList.remove("hidden");
    $("stat-cards").textContent = "—";
    $("stat-value").textContent = "—";
    $("stat-cost").textContent = "—";
  }
}

$("site-title").textContent = CONFIG.siteTitle;
document.title = CONFIG.siteTitle;

$("search").addEventListener("input", () => {
  currentPage = 1;
  render();
});
$("year-filter").addEventListener("change", () => {
  currentPage = 1;
  render();
});
$("sort").addEventListener("change", () => {
  currentPage = 1;
  render();
});
$("page-size").addEventListener("change", () => {
  currentPage = 1;
  render();
});

$("clear-filters").addEventListener("click", () => {
  setWatchlist(false);
  $("search").value = "";
  $("year-filter").value = "";
  $("sort").value = "sheet";
  $("page-size").value = String(CONFIG.defaultPageSize);
  currentPage = 1;
  render();
});

$("market-sync-btn").addEventListener("click", startMarketSync);
$("refresh-btn").addEventListener("click", loadCards);
$("dialog-close").addEventListener("click", () => {
  $("card-dialog").close();
});
$("card-dialog").addEventListener("click", (e) => {
  if (e.target === $("card-dialog")) {
    $("card-dialog").close();
  }
});

document.addEventListener("paste", event => {
  if (!$("card-dialog")?.open || !customEditorOpen || activeDetailIndex === null) return;

  const file = [...(event.clipboardData?.items || [])]
    .find(item => String(item.type || "").startsWith("image/"))
    ?.getAsFile();

  if (!file) return;

  event.preventDefault();
  uploadCustomImage(activeDetailIndex, file);
});

let watchlistOnly=false,unconfirmedOnly=false;
function isUnconfirmed(row){const d=marketGridSummaries[marketKey(row)]||{};return d.state==='review'||(!d.id&&!d.manualId);}
let watchlist;try{watchlist=new Set(JSON.parse(localStorage.getItem('football-watchlist-v1')||'[]'));}catch{watchlist=new Set();}
function toggleFavorite(index){const key=marketKey(rows[index]);const next=new Set(watchlist);next.has(key)?next.delete(key):next.add(key);try{localStorage.setItem('football-watchlist-v1',JSON.stringify([...next]));watchlist=next;render();}catch{alert('Your browser could not save the watchlist. Check browser storage settings.');}}
function setWatchlist(only){unconfirmedOnly=false;$("unconfirmed-tab").classList.remove("active");watchlistOnly=only;currentPage=1;$('watchlist-tab').classList.toggle('active',only);$('all-cards-tab').classList.toggle('active',!only);$('collection-title').textContent=only?'Watchlist':'All cards';render();}
$('watchlist-tab').onclick=()=>setWatchlist(true);
$('all-cards-tab').onclick=()=>setWatchlist(false);
$('unconfirmed-tab').onclick=()=>{setWatchlist(false);unconfirmedOnly=true;$('all-cards-tab').classList.remove('active');$('unconfirmed-tab').classList.add('active');$('collection-title').textContent='Unconfirmed cards';render();};
for(const [id,label] of [['year-filter','Year'],['sort','Sort by'],['page-size','Show']]){const wrap=document.createElement('label');wrap.className='sidebar-field';wrap.textContent=label;wrap.appendChild($(id));$('sidebar-filters').appendChild(wrap);}
const grades=['7','8','9','9.5','PSA 10'];
let manualGradeEntries={},manualGradesReady=false;
async function loadManualGradeIndex(){try{const r=await fetch('/.netlify/functions/manual-grade-index',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error();manualGradeEntries=d.entries||{};manualGradesReady=true;}catch{manualGradesReady=false;}}
async function loadManualGrades(index){
 const panel=$('manual-grades'),key=marketKey(rows[index]);
 try{const r=await fetch('/.netlify/functions/manual-grades?key='+encodeURIComponent(key),{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not read saved prices.');if(panel!==$('manual-grades'))return;
 manualGradeEntries[key]=d;applyGridMarketSummaries();updateStats();
 panel.innerHTML='<h3>My graded prices</h3><p class="market-small-label">Choose one grade to show beside the ungraded value. Apply it to use that price for every copy of this card in the collection total.</p><form id="manual-grade-form"><div class="manual-grade-grid">'+grades.map(g=>'<label><span class="grade-choice"><input type="radio" name="selected-grade" value="'+g+'" '+(d.selectedGrade===g?'checked':'')+' aria-label="Show '+g+' on card">'+escapeHtml(g==='PSA 10'?g:'Grade '+g)+'</span><input type="number" min="0" max="100000000" step="0.01" data-grade="'+g+'" aria-label="'+g+' price" placeholder="—" value="'+escapeHtml(d.prices?.[g]??'')+'"></label>').join('')+'</div><label class="no-grade-choice"><input type="radio" name="selected-grade" value="" '+(!d.selectedGrade?'checked':'')+'> No grade displayed</label><div class="grade-save-actions"><button class="button primary" type="submit">Save graded prices</button><button class="button secondary" type="submit" data-grade-action="apply">Apply selected grade to collection value</button><button class="button secondary" type="submit" data-grade-action="reset">Use ungraded in total</button></div><span id="manual-grade-status" role="status">'+(d.applyToCollection?'Collection total uses '+escapeHtml(d.selectedGrade)+'.':'Collection total uses the ungraded price.')+'</span></form>';
 const form=$('manual-grade-form');form.onsubmit=async event=>{event.preventDefault();const password=requestAdminPassword();if(!password)return;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);const status=form.querySelector('[role=status]');status.textContent='Saving…';try{const prices={};form.querySelectorAll('[data-grade]').forEach(input=>prices[input.dataset.grade]=input.value===''?null:Number(input.value));const selectedGrade=form.querySelector('[name=selected-grade]:checked')?.value||null;const action=event.submitter?.dataset.gradeAction;const applyToCollection=action==='apply'?true:action==='reset'?false:Boolean(d.applyToCollection)&&Boolean(selectedGrade);if(applyToCollection&&!selectedGrade)throw Error('Select a grade first.');if(selectedGrade&&prices[selectedGrade]===null)throw Error('Enter a price for the selected grade.');const response=await fetch('/.netlify/functions/manual-grades',{method:'POST',headers:{'content-type':'application/json','x-catalog-admin':password},body:JSON.stringify({key,prices,selectedGrade,applyToCollection})});const result=await response.json();if(!response.ok){if(response.status===401)sessionStorage.removeItem('football-card-admin-password');throw Error(result.error||'Save failed.');}Object.assign(d,result);manualGradeEntries[key]=result;if(!manualGradesReady)await loadManualGradeIndex();applyGridMarketSummaries();updateStats();status.textContent='Saved. '+(result.applyToCollection?'Collection total uses '+result.selectedGrade+'.':'Collection total uses the ungraded price.');}catch(e){status.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}};
 }catch(e){if(panel===$('manual-grades'))panel.innerHTML='<h3>My graded prices</h3><p>'+escapeHtml(e.message)+'</p><button class="button" onclick="loadManualGrades('+index+')">Retry</button>';}
}

loadCards();
