const CONFIG = {
  siteTitle: "Football Card Archive",
  dataEndpoint: "/.netlify/functions/cards",
  imageManifest: "/card-images.json",
  autoImageEndpoint: "/.netlify/functions/card-image",
  imageCacheStorageKey: "football-card-archive-image-cache-v1"
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
const pendingImageKeys = new Set();

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

function setCachedAutoImage(key, payload) {
  autoImageCache[key] = {
    imageUrl: payload.imageUrl || "",
    sourcePage: payload.sourcePage || "",
    cachedAt: new Date().toISOString()
  };
  saveStoredImageCache();
}

function imageUrlFor(row) {
  const sheetUrl = field(row, "image");
  if (sheetUrl && /^https?:\/\//i.test(sheetUrl)) return sheetUrl;

  const manifest = imageManifest[cardKey(row)];
  if (typeof manifest === "string" && /^https?:\/\//i.test(manifest)) return manifest;
  if (manifest && /^https?:\/\//i.test(manifest.url || "")) return manifest.url;

  const cached = getCachedAutoImage(cardKey(row));
  if (cached) return cached;

  return "";
}

function imageTagHtml(url, alt, detail = false) {
  const klass = detail ? "detail-image-tag" : "card-image";
  return `<img class="${klass}"
      src="${escapeHtml(url)}"
      alt="${alt}"
      loading="lazy"
      referrerpolicy="no-referrer">`;
}

function placeholderHtml(row, realIndex) {
  return `<div class="card-placeholder auto-image"
      data-index="${realIndex}"
      data-key="${escapeHtml(cardKey(row))}">
      <strong>${escapeHtml(initials(titleFor(row)))}</strong>
    </div>`;
}

function imageHtml(row, realIndex, detail=false) {
  const src = imageUrlFor(row);
  const alt = escapeHtml(cardQuery(row) || titleFor(row));

  if (src) {
    return imageTagHtml(src, alt, detail);
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

function render() {
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

  const totalCards = filtered.reduce((sum,r)=>sum+quantity(r),0);
  $("results-count").textContent =
    `${totalCards.toLocaleString()} card${totalCards===1?"":"s"} · ` +
    `${filtered.length.toLocaleString()} catalog entr${filtered.length===1?"y":"ies"}`;

  $("catalog").innerHTML = filtered.map((row) => {
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

  $("empty-state").classList.toggle("hidden", filtered.length > 0);

  document.querySelectorAll(".details-button").forEach(btn => {
    btn.addEventListener("click", () => openDetails(Number(btn.dataset.index)));
  });

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

function updatePlaceholdersForKey(key, imageUrl) {
  if (!imageUrl) return;
  const alt = escapeHtml(key);
  document.querySelectorAll(`.auto-image[data-key="${CSS.escape(key)}"]`).forEach(node => {
    node.outerHTML = imageTagHtml(imageUrl, alt, false);
  });
}

async function fetchAutoImageForRow(row) {
  const key = cardKey(row);
  if (!key) return;
  if (imageUrlFor(row)) {
    updatePlaceholdersForKey(key, imageUrlFor(row));
    return;
  }
  if (pendingImageKeys.has(key)) return;

  pendingImageKeys.add(key);

  try {
    const params = new URLSearchParams({
      player: fullName(row),
      year: field(row, "year"),
      brand: brandFor(row),
      type: cardTypeFor(row),
      number: field(row, "cardNumber"),
      rookie: isRookie(row) ? "Y" : "N"
    });

    const response = await fetch(`${CONFIG.autoImageEndpoint}?${params.toString()}`);
    const payload = await response.json();

    if (response.ok && payload.imageUrl) {
      setCachedAutoImage(key, payload);
      updatePlaceholdersForKey(key, payload.imageUrl);
    }
  } catch (error) {
    console.warn("Auto image lookup failed:", key, error);
  } finally {
    pendingImageKeys.delete(key);
  }
}

function setupAutoImageLoading() {
  if (imageObserver) imageObserver.disconnect();

  imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const index = Number(entry.target.dataset.index);
      const row = rows[index];
      if (row) fetchAutoImageForRow(row);
      imageObserver.unobserve(entry.target);
    });
  }, { rootMargin: "250px 0px" });

  document.querySelectorAll(".auto-image[data-index]").forEach(node => {
    imageObserver.observe(node);
  });
}

function openDetails(index) {
  const row = rows[index];
  if (!row) return;

  fetchAutoImageForRow(row);

  const fields = Object.entries(row).filter(([,v]) => String(v ?? "").trim() !== "");
  const q = encodeURIComponent(cardQuery(row));
  const googleImages = `https://www.google.com/search?tbm=isch&q=${q}`;
  const ebaySold = `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`;

  $("dialog-content").innerHTML = `
    <div class="detail-grid">
      <div class="detail-image">${imageHtml(row, index, true)}</div>
      <div class="detail-body">
        ${metaLine(row) ? `<div class="eyebrow">${escapeHtml(metaLine(row))}</div>` : ""}
        <h2>${escapeHtml(titleFor(row))}</h2>
        ${subtitle(row) ? `<div class="detail-subtitle">${escapeHtml(subtitle(row))}</div>` : ""}

        <div class="detail-table">
          ${fields.map(([k,v]) => `
            <div class="detail-field">
              <span>${escapeHtml(k)}</span>
              <strong>${escapeHtml(v)}</strong>
            </div>`).join("")}
        </div>

        <div class="detail-actions">
          <a class="primary" href="${ebaySold}" target="_blank" rel="noopener">Recent eBay sales</a>
          <a href="${googleImages}" target="_blank" rel="noopener">Image search</a>
        </div>
      </div>
    </div>`;
  $("card-dialog").showModal();
}

async function loadCards() {
  $("sync-text").textContent = "Connecting";
  $("sync-pill").classList.remove("online");
  $("status-line").textContent = "Connecting to Google Sheets…";
  $("error-state").classList.add("hidden");

  try {
    loadStoredImageCache();

    const [response, manifestResponse] = await Promise.all([
      fetch(`${CONFIG.dataEndpoint}?ts=${Date.now()}`, { cache: "no-store" }),
      fetch(`${CONFIG.imageManifest}?ts=${Date.now()}`, { cache: "no-store" }).catch(() => null)
    ]);

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);

    imageManifest = (manifestResponse && manifestResponse.ok)
      ? await manifestResponse.json()
      : {};

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

$("search").addEventListener("input", render);
$("year-filter").addEventListener("change", render);
$("sort").addEventListener("change", render);

$("clear-filters").addEventListener("click", () => {
  $("search").value = "";
  $("year-filter").value = "";
  $("sort").value = "sheet";
  render();
});

$("refresh-btn").addEventListener("click", loadCards);
$("dialog-close").addEventListener("click", () => $("card-dialog").close());
$("card-dialog").addEventListener("click", (e) => {
  if (e.target === $("card-dialog")) $("card-dialog").close();
});

loadCards();
