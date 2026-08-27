const CONFIG = {
  siteTitle: "Football Card Archive",
  dataEndpoint: "/.netlify/functions/cards",
  imageManifest: "/card-images.json"
};

const ALIASES = {
  player: [
    "player", "player name", "player names", "player(s)", "players",
    "athlete", "athlete name", "subject", "subject name"
  ],
  year: ["year", "card year", "season", "yr"],
  set: ["set", "set name", "product", "product name", "brand", "card set"],
  cardNumber: [
    "card #", "card no", "card no.", "card number", "card num",
    "card num.", "number", "no.", "#"
  ],
  parallel: ["parallel", "variation", "variant", "insert", "parallel/variation"],
  team: ["team", "nfl team", "team name"],
  grade: ["grade", "card grade", "numeric grade"],
  grader: ["grader", "grading company", "grading service", "grading co"],
  quantity: ["qty", "quantity", "count", "copies"],
  purchasePrice: ["purchase price", "cost", "price paid", "paid", "purchase cost"],
  value: ["market value", "value", "current value", "estimated value", "est value"],
  lastSale: ["last sale", "last sold", "recent sale"],
  avg30: ["30-day avg", "30 day avg", "30-day average", "30 day average"],
  image: ["image url", "image", "photo url", "photo", "picture", "card image"],
  serial: ["serial", "serial #", "serial number", "numbered", "serial numbered"],
  notes: ["notes", "note", "comments"]
};

const FUZZY = {
  player: [/\bplayer\b/i, /\bathlete\b/i, /\bsubject\b/i],
  year: [/\byear\b/i, /\bseason\b/i],
  set: [/\bset\b/i, /\bproduct\b/i, /\bbrand\b/i],
  cardNumber: [/card.*(number|num|no|#)/i],
  parallel: [/\bparallel\b/i, /\bvariation\b/i, /\bvariant\b/i],
  team: [/\bteam\b/i],
  grade: [/\bgrade\b/i],
  grader: [/\bgrader\b/i, /grading.*(company|service|co)/i],
  quantity: [/\bqty\b/i, /\bquantity\b/i, /\bcopies\b/i],
  purchasePrice: [/purchase.*(price|cost)/i, /price.*paid/i],
  value: [/market.*value/i, /current.*value/i, /estimated.*value/i],
  image: [/\bimage\b/i, /\bphoto\b/i, /\bpicture\b/i],
  serial: [/\bserial\b/i],
  notes: [/\bnotes?\b/i, /\bcomments?\b/i]
};

let rows = [];
let mapping = {};
let imageManifest = {};

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
    // First: exact normalized aliases
    const exact = normalized.find(h => aliases.map(norm).includes(h.normalized));
    if (exact) {
      result[key] = exact.original;
      continue;
    }

    // Second: semantic/fuzzy header matching
    const patterns = FUZZY[key] || [];
    const fuzzy = normalized.find(h => patterns.some(p => p.test(h.original)));
    result[key] = fuzzy ? fuzzy.original : "";
  }

  return result;
}

function field(row, key) {
  const header = mapping[key];
  return header ? String(row[header] ?? "").trim() : "";
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
  // v4: never substitute the set/product as the player name.
  return field(row, "player") || "Unknown Player";
}

function cardQuery(row) {
  return [
    field(row, "year"),
    field(row, "set"),
    field(row, "player"),
    field(row, "cardNumber") ? `#${field(row, "cardNumber")}` : "",
    field(row, "parallel"),
    field(row, "grade"),
    field(row, "grader")
  ].filter(Boolean).join(" ");
}

function cardKey(row) {
  return [
    field(row, "year"),
    field(row, "set"),
    field(row, "player"),
    field(row, "cardNumber"),
    field(row, "parallel"),
    field(row, "grade"),
    field(row, "grader")
  ].map(v => norm(v)).join("|");
}

function imageUrlFor(row) {
  const sheetUrl = field(row, "image");
  if (sheetUrl && /^https?:\/\//i.test(sheetUrl)) return sheetUrl;

  const manifest = imageManifest[cardKey(row)];
  if (typeof manifest === "string" && /^https?:\/\//i.test(manifest)) return manifest;
  if (manifest && /^https?:\/\//i.test(manifest.url || "")) return manifest.url;

  return "";
}

function imageHtml(row, detail=false) {
  const src = imageUrlFor(row);
  const alt = escapeHtml(cardQuery(row) || titleFor(row));

  if (src) {
    return `<img class="${detail ? "" : "card-image"}"
      src="${escapeHtml(src)}"
      alt="${alt}"
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror="this.parentElement.innerHTML='<div class=&quot;card-placeholder&quot;><strong>${escapeHtml(initials(titleFor(row)))}</strong></div>'">`;
  }

  return `<div class="card-placeholder"><strong>${escapeHtml(initials(titleFor(row)))}</strong></div>`;
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0,2)
    .map(x => x[0]).join("").toUpperCase() || "FC";
}

function metaLine(row) {
  return [field(row, "year"), field(row, "set")].filter(Boolean).join(" · ");
}

function subtitle(row) {
  // v4: card number has NO # prefix, and no "Football Card" fallback.
  const bits = [];
  if (field(row, "cardNumber")) bits.push(field(row, "cardNumber"));
  if (field(row, "parallel")) bits.push(field(row, "parallel"));
  if (field(row, "team")) bits.push(field(row, "team"));
  return bits.join(" · ");
}

function gradeText(row) {
  const g = field(row, "grade");
  const company = field(row, "grader");
  return [company, g].filter(Boolean).join(" ");
}

function searchable(row) {
  return Object.values(row).join(" ").toLowerCase();
}

function render() {
  let filtered = [...rows];
  const q = norm($("search").value);
  const year = $("year-filter").value;
  const team = $("team-filter").value;
  const grade = $("grade-filter").value;

  if (q) filtered = filtered.filter(r => searchable(r).includes(q));
  if (year) filtered = filtered.filter(r => field(r, "year") === year);
  if (team) filtered = filtered.filter(r => field(r, "team") === team);
  if (grade) filtered = filtered.filter(r => gradeText(r) === grade);

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
    const grade = gradeText(row);
    const sub = subtitle(row);

    return `
      <article class="card">
        <div class="card-image-wrap">
          ${imageHtml(row)}
          ${grade ? `<span class="grade-badge">${escapeHtml(grade)}</span>` : ""}
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
}

function openDetails(index) {
  const row = rows[index];
  if (!row) return;

  const fields = Object.entries(row).filter(([,v]) => String(v ?? "").trim() !== "");
  const q = encodeURIComponent(cardQuery(row));
  const googleImages = `https://www.google.com/search?tbm=isch&q=${q}`;
  const ebaySold = `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`;

  $("dialog-content").innerHTML = `
    <div class="detail-grid">
      <div class="detail-image">${imageHtml(row, true)}</div>
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
    const [response, manifestResponse] = await Promise.all([
      fetch(`${CONFIG.dataEndpoint}?ts=${Date.now()}`, { cache: "no-store" }),
      fetch(`${CONFIG.imageManifest}?ts=${Date.now()}`, { cache: "no-store" })
        .catch(() => null)
    ]);

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);

    if (manifestResponse && manifestResponse.ok) {
      imageManifest = await manifestResponse.json();
    } else {
      imageManifest = {};
    }

    rows = payload.rows || [];
    if (!rows.length) throw new Error("The sheet connected, but no card rows were found.");

    const headers = payload.headers || Object.keys(rows[0] || {});
    mapping = mapHeaders(headers);

    updateStats();
    setOptions("year-filter", rows.map(r=>field(r,"year")), "All years");
    setOptions("team-filter", rows.map(r=>field(r,"team")), "All teams");
    setOptions("grade-filter", rows.map(r=>gradeText(r)), "All grades");
    render();

    $("sync-text").textContent = "Live";
    $("sync-pill").classList.add("online");
    $("status-line").textContent =
      `${rows.length.toLocaleString()} catalog entries loaded from your Google Sheet.`;
    $("last-updated").textContent = `Last refreshed ${new Date().toLocaleString()}`;

    // Helpful diagnostic in browser DevTools.
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

["search","year-filter","team-filter","grade-filter","sort"].forEach(id => {
  $(id).addEventListener(id === "search" ? "input" : "change", render);
});

$("clear-filters").addEventListener("click", () => {
  $("search").value = "";
  $("year-filter").value = "";
  $("team-filter").value = "";
  $("grade-filter").value = "";
  $("sort").value = "sheet";
  render();
});

$("refresh-btn").addEventListener("click", loadCards);
$("dialog-close").addEventListener("click", () => $("card-dialog").close());
$("card-dialog").addEventListener("click", (e) => {
  if (e.target === $("card-dialog")) $("card-dialog").close();
});

loadCards();
