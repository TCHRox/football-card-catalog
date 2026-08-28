const CONFIG = {
  siteTitle: "Football Card Archive",
  dataEndpoint: "/.netlify/functions/cards",
  imageManifest: "/card-images.json",
  imageBatchEndpoint: "/.netlify/functions/card-images-batch",
  customImageEndpoint: "/.netlify/functions/custom-card-image",
  marketEndpoint: "/.netlify/functions/card-market",
  marketSalesEndpoint: "/.netlify/functions/card-market-sales",
  imageCacheStorageKey: "football-card-archive-image-cache-v5",
  imageBatchSize: 8,
  imageBatchConcurrency: 2,
  initialImageLookahead: 48,
  defaultPageSize: 250
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
const marketDataCache = new Map();
const marketRangeByCard = new Map();

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
      filtered.sort((a,b) => moneyNumber(field(b,"value")) - moneyNumber(field(a,"value")));
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
    return `
      <article class="card">
        <div class="card-image-wrap">
          ${imageHtml(row, realIndex, false)}
          ${isRookie(row) ? '<span class="grade-badge">RC</span>' : ""}
        </div>
        <div class="card-body">
          ${metaLine(row) ? `<div class="card-meta">${escapeHtml(metaLine(row))}</div>` : ""}
          <h3 class="card-name">${escapeHtml(titleFor(row))}</h3>
          ${sub ? `<div class="card-subtitle">${escapeHtml(sub)}</div>` : ""}
          <div class="card-bottom">
            <div>
              <div class="value-label">Market value</div>
              <div class="card-value">${money(field(row,"value"))}</div>
            </div>
            <button class="details-button" data-index="${realIndex}">Details →</button>
          </div>
        </div>
      </article>`;
  }).join("");

  $("empty-state").classList.toggle("hidden", totalEntries > 0);

  document.querySelectorAll(".details-button").forEach(btn => {
    btn.addEventListener("click", () => openDetails(Number(btn.dataset.index)));
  });

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
  const totalValue = rows.reduce((sum,r) =>
    sum + moneyNumber(field(r,"value")) * quantity(r), 0);
  const totalCost = rows.reduce((sum,r) =>
    sum + moneyNumber(field(r,"purchasePrice")) * quantity(r), 0);

  $("stat-cards").textContent = cardCount.toLocaleString();
  $("stat-value").textContent = totalValue ? money(totalValue) : "—";
  $("stat-cost").textContent = totalCost ? money(totalCost) : "—";

  const valueCard = document.getElementById("stat-value")?.closest(".stat-card");
  const costCard = document.getElementById("stat-cost")?.closest(".stat-card");
  if (valueCard) valueCard.style.display = mapping.value ? "" : "none";
  if (costCard) costCard.style.display = mapping.purchasePrice ? "" : "none";

  const stats = document.querySelector(".stats");
  if (stats) {
    const visibleCards = Array.from(stats.querySelectorAll(".stat-card")).filter(card => card.style.display !== "none").length;
    stats.style.gridTemplateColumns = `repeat(${Math.max(1, visibleCards)}, 1fr)`;
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

function marketQuery(row) {
  const params = new URLSearchParams({
    player: fullName(row),
    year: field(row, "year"),
    brand: brandFor(row),
    type: cardTypeFor(row),
    number: field(row, "cardNumber"),
    rookie: isRookie(row) ? "Y" : "N",
    notes: field(row, "notes")
  });

  // Reuse a SportsCardsPro page already discovered by the image search.
  // This can completely skip the slower card-discovery step.
  const autoImage = getCachedAutoImageData(cardKey(row));
  const sourcePage = String(autoImage?.sourcePage || "");

  if (/sportscardspro\.com\/game\//i.test(sourcePage)) {
    params.set("preferredUrl", sourcePage);
  }

  return params;
}

function renderMarketLoading() {
  return `
    <section class="market-panel market-loading">
      <div class="market-loading-head">
        <div>
          <div class="section-kicker">MARKET DATA</div>
          <h3>Loading SportsCardsPro history…</h3>
        </div>
        <span class="market-spinner" aria-hidden="true"></span>
      </div>
      <div class="market-skeleton chart-skeleton"></div>
      <div class="grade-skeleton-row">
        ${Array.from({length: 6}, () => '<div class="market-skeleton grade-skeleton"></div>').join("")}
      </div>
    </section>`;
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
        <span>Grade values and recent sales may still be available below.</span>
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
  const path = xy
    .map((p,i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");

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

  const dots = clean.map(s => `
    <circle cx="${x(s.timestamp).toFixed(1)}" cy="${y(s.numericPrice).toFixed(1)}" r="3.5" class="chart-dot">
      <title>${escapeHtml(`${s.date}: ${marketMoney(s.numericPrice)}`)}</title>
    </circle>`).join("");

  return `
    <svg class="sales-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historical card price chart">
      ${yTicks}
      <path d="${path}" class="chart-line"/>
      ${dots}
      <text x="${L}" y="${H-10}" class="chart-axis-label">${escapeHtml(firstDate)}</text>
      <text x="${W/2}" y="${H-10}" class="chart-axis-label" text-anchor="middle">${escapeHtml(midDate)}</text>
      <text x="${W-R}" y="${H-10}" class="chart-axis-label" text-anchor="end">${escapeHtml(lastDate)}</text>
    </svg>`;
}

function preferredGradeCards(prices) {
  const order = [
    "Ungraded",
    "Grade 8",
    "Grade 9",
    "Grade 9.5",
    "SGC 10",
    "CGC 10",
    "PSA 10",
    "BGS 10",
    "BGS 10 Black",
    "CGC 10 Pristine",
    "TAG 10",
    "ACE 10"
  ];

  const byLabel = new Map((prices || []).map(p => [p.label, p]));
  const ordered = order.map(label => byLabel.get(label)).filter(Boolean);

  for (const item of prices || []) {
    if (!ordered.some(existing => existing.label === item.label)) {
      ordered.push(item);
    }
  }

  return ordered.slice(0, 8);
}

function filterTrendForRange(points, range) {
  const sorted = (points || [])
    .filter(p => Number.isFinite(Date.parse(p.date)))
    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date));

  if (!sorted.length || range === "all") return sorted;

  const newest = Date.parse(sorted[sorted.length - 1].date);
  const years = range === "1y" ? 1 : 5;
  const cutoff = new Date(newest);
  cutoff.setFullYear(cutoff.getFullYear() - years);

  return sorted.filter(p => Date.parse(p.date) >= cutoff.getTime());
}

function trendDepthLabel(points) {
  const sorted = (points || [])
    .filter(p => Number.isFinite(Date.parse(p.date)))
    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date));

  if (sorted.length < 2) return "";

  const first = new Date(sorted[0].date);
  const last = new Date(sorted[sorted.length - 1].date);
  const months = Math.max(
    1,
    (last.getFullYear() - first.getFullYear()) * 12 +
    last.getMonth() - first.getMonth()
  );

  if (months >= 24) return `${(months / 12).toFixed(1)} years of history`;
  return `${months} months of history`;
}

function saleSearchUrl(sale) {
  const direct = String(sale?.url || "").trim();
  if (/^https?:\/\//i.test(direct)) return direct;

  const title = String(sale?.title || "").trim();
  if (!title) return "";

  const marketplace = String(sale?.marketplace || "").toLowerCase();

  if (!marketplace || marketplace.includes("ebay")) {
    return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}&LH_Sold=1&LH_Complete=1`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(`${title} ${sale.marketplace || ""} sold`)}`;
}

function saleLinkLabel(sale) {
  return sale?.url ? "Open sale" : "Find sale";
}

function renderMarketData(data, cardKeyValue) {
  if (!data || !data.found) {
    const needsSetup = data?.code === "PARSE_API_NOT_CONFIGURED";

    return `
      <section class="market-panel market-unavailable">
        <div class="section-kicker">MARKET DATA</div>
        <h3>${needsSetup ? "Market API needs setup" : "No reliable SportsCardsPro match found"}</h3>
        <p>${escapeHtml(
          data?.message ||
          data?.error ||
          "This card could not be matched confidently to SportsCardsPro."
        )}</p>
        ${needsSetup ? `
          <div class="market-setup-help">
            Add <code>PARSE_API_KEY</code> to Netlify Environment Variables,
            make sure Functions can access it, then redeploy.
          </div>` : ""}
      </section>`;
  }

  const raw = (data.prices || []).find(p => p.label === "Ungraded");
  const recent = data.sales || [];
  const gradeCards = preferredGradeCards(data.prices);
  const allTrend = data.trend || [];
  const selectedRange = marketRangeByCard.get(cardKeyValue) || "5y";
  const chartPoints = filterTrendForRange(allTrend, selectedRange);

  const avg = recent.length
    ? recent.reduce((sum,s) => sum + Number(s.numericPrice || 0), 0) / recent.length
    : null;

  const latestTrendPoint = allTrend
    .filter(p => Number.isFinite(Number(p.numericPrice)))
    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date))
    .at(-1);

  const marketValue = raw?.value ?? latestTrendPoint?.numericPrice ?? null;
  const historyDepth = trendDepthLabel(allTrend);

  return `
    <section class="market-panel">
      <div class="market-summary-row">
        <div>
          <div class="section-kicker">MARKET VALUE</div>
          <div class="market-primary-value">${marketMoney(marketValue)}</div>
          <div class="market-small-label">Current ungraded estimate</div>
        </div>

        <div class="market-mini-stat">
          <span>Recent sales</span>
          <strong>${recent.length || "—"}</strong>
        </div>

        <div class="market-mini-stat">
          <span>Recent avg.</span>
          <strong>${marketMoney(avg)}</strong>
        </div>

        <a class="source-link" href="${escapeHtml(data.sourceUrl || "https://www.sportscardspro.com/")}" target="_blank" rel="noopener">
          SportsCardsPro ↗
        </a>
      </div>

      <div class="market-chart-card">
        <div class="market-section-heading chart-heading-with-controls">
          <div>
            <div class="section-kicker">PRICE HISTORY</div>
            <h3>Ungraded market trend</h3>
            ${historyDepth ? `<span class="history-depth">${escapeHtml(historyDepth)} available</span>` : ""}
          </div>

          <div class="chart-range-controls" role="group" aria-label="Chart range">
            ${[
              ["1y", "1Y"],
              ["5y", "5Y"],
              ["all", "All"]
            ].map(([value,label]) => `
              <button type="button"
                class="chart-range-button ${selectedRange === value ? "active" : ""}"
                data-market-range="${value}">
                ${label}
              </button>`).join("")}
          </div>
        </div>

        ${chartSvg(chartPoints)}
      </div>

      <div class="grade-section">
        <div class="market-section-heading">
          <div>
            <div class="section-kicker">PRICE GUIDE</div>
            <h3>Values by grade</h3>
          </div>
        </div>

        ${gradeCards.length ? `
          <div class="grade-price-grid">
            ${gradeCards.map(item => `
              <div class="grade-price-card">
                <span>${escapeHtml(item.label)}</span>
                <strong>${marketMoney(item.value)}</strong>
              </div>`).join("")}
          </div>` : `
          <div class="market-empty-copy">No grade-specific prices are currently available for this card.</div>
        `}
      </div>

      <div class="recent-sales-section">
        <div class="market-section-heading">
          <div>
            <div class="section-kicker">RECENT SALES</div>
            <h3>Completed listings</h3>
          </div>
        </div>

        ${recent.length ? `
          <div class="sales-list">
            ${recent.slice(0, 10).map(sale => {
              const href = saleSearchUrl(sale);
              return `
                <a class="sale-row" href="${escapeHtml(href)}" target="_blank" rel="noopener"
                   title="${escapeHtml(saleLinkLabel(sale))}">
                  <span class="sale-date">${escapeHtml(sale.date || "")}</span>
                  <span class="sale-title">${escapeHtml(sale.title || "Completed sale")}</span>
                  <strong class="sale-price">${marketMoney(sale.numericPrice)}</strong>
                  <span class="sale-arrow">↗</span>
                </a>`;
            }).join("")}
          </div>` : data.salesPending ? `
          <div class="sales-loading-row">
            <span class="market-spinner" aria-hidden="true"></span>
            <span>Loading recent completed sales…</span>
          </div>` : `
          <div class="market-empty-copy">
            No recent ungraded completed listings were returned for this card.
          </div>
        `}
      </div>

      <div class="market-source-note">
        Pricing, monthly historical trend data, and completed-sale history are sourced through
        the managed <a href="https://parse.bot/marketplace/6808cd1c-6144-442b-b0db-17727c37d562/sportscardspro-com-api"
        target="_blank" rel="noopener">SportsCardsPro API on Parse</a>.
        Historical depth varies by card. Sale rows open the original listing when a URL is available;
        otherwise they open a sold-listing search using the exact sale title.
      </div>
    </section>`;
}

function attachMarketRangeEvents(data, cardKeyValue) {
  document.querySelectorAll("[data-market-range]").forEach(button => {
    button.addEventListener("click", () => {
      marketRangeByCard.set(cardKeyValue, button.dataset.marketRange || "5y");

      const target = $("market-content");
      if (!target) return;

      target.innerHTML = renderMarketData(data, cardKeyValue);
      attachMarketRangeEvents(data, cardKeyValue);
    });
  });
}

async function loadMarketSales(index, marketData) {
  const row = rows[index];
  if (!row || !marketData?.cardId) return;

  const key = cardKey(row);

  // get_card sometimes already includes sales; don't spend another API call if so.
  if ((marketData.sales || []).length) return;

  try {
    const params = new URLSearchParams({
      cardId: marketData.cardId,
      title: `${fullName(row)} ${field(row, "year")} ${brandFor(row)} ${field(row, "cardNumber")}`
    });

    const response = await fetch(
      `${CONFIG.marketSalesEndpoint}?${params.toString()}`,
      { cache: "default" }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      marketData.salesPending = false;
      marketData.salesError = payload.message || payload.error || `Sales lookup failed (${response.status}).`;
    } else {
      marketData.sales = payload.sales || [];
      marketData.salesPending = false;
    }

    marketDataCache.set(key, marketData);

    if (activeDetailIndex === index && $("market-content")) {
      $("market-content").innerHTML = renderMarketData(marketData, key);
      attachMarketRangeEvents(marketData, key);
    }
  } catch (error) {
    marketData.salesPending = false;
    marketData.salesError = error.message;
    marketDataCache.set(key, marketData);

    if (activeDetailIndex === index && $("market-content")) {
      $("market-content").innerHTML = renderMarketData(marketData, key);
      attachMarketRangeEvents(marketData, key);
    }
  }
}

async function loadMarketData(index) {
  const row = rows[index];
  if (!row) return;

  const key = cardKey(row);
  const target = $("market-content");
  if (!target) return;

  if (marketDataCache.has(key)) {
    const cached = marketDataCache.get(key);
    target.innerHTML = renderMarketData(cached, key);
    attachMarketRangeEvents(cached, key);
    return;
  }

  try {
    const response = await fetch(
      `${CONFIG.marketEndpoint}?${marketQuery(row).toString()}`,
      { cache: "default" }
    );

    const payload = await response.json().catch(() => ({}));

    const data = response.ok
      ? payload
      : {
          found: false,
          code: payload.code || "",
          message: payload.message || payload.error || `Market lookup failed (${response.status}).`
        };

    if (data.found && !(data.sales || []).length) {
      data.salesPending = true;
    }

    marketDataCache.set(key, data);

    if (activeDetailIndex === index && $("market-content")) {
      $("market-content").innerHTML = renderMarketData(data, key);
      attachMarketRangeEvents(data, key);
    }

    if (data.found && data.salesPending) {
      loadMarketSales(index, data);
    }
  } catch (error) {
    const data = {
      found: false,
      message: `Market lookup failed: ${error.message}`
    };

    marketDataCache.set(key, data);

    if (activeDetailIndex === index && $("market-content")) {
      $("market-content").innerHTML = renderMarketData(data, key);
    }
  }
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

      <main class="market-detail-main">
        <div id="market-content">
          ${renderMarketLoading()}
        </div>
      </main>
    </div>`;

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

    const [response, manifestResponse, customIndex] = await Promise.all([
      fetch(`${CONFIG.dataEndpoint}?ts=${Date.now()}`, { cache: "no-store" }),
      fetch(`${CONFIG.imageManifest}?ts=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      loadCustomImageIndex()
    ]);

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);

    imageManifest = (manifestResponse && manifestResponse.ok)
      ? await manifestResponse.json()
      : {};

    customImageIndex = customIndex || {};

    const sourceRows = payload.rows || [];
    if (!sourceRows.length) throw new Error("The sheet connected, but no card rows were found.");

    const headers = payload.headers || Object.keys(sourceRows[0] || {});
    mapping = applyKnownColumnLayout(headers, mapHeaders(headers));

    rows = inheritPlayerNames(sourceRows);

    updateStats();
    setOptions("year-filter", rows.map(r=>field(r,"year")), "All years");

    document.getElementById("team-filter").style.display = "none";
    document.getElementById("grade-filter").style.display = "none";

    render();

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
  $("search").value = "";
  $("year-filter").value = "";
  $("sort").value = "sheet";
  $("page-size").value = String(CONFIG.defaultPageSize);
  currentPage = 1;
  render();
});

$("refresh-btn").addEventListener("click", loadCards);
$("dialog-close").addEventListener("click", () => $("card-dialog").close());
$("card-dialog").addEventListener("click", (e) => {
  if (e.target === $("card-dialog")) $("card-dialog").close();
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

loadCards();
