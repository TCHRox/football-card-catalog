const CONFIG = {
  siteTitle: "Football Card Archive",
  dataEndpoint: "/.netlify/functions/cards"
};

const ALIASES = {
  player: ["player", "player name", "name", "athlete"],
  year: ["year", "card year", "season"],
  set: ["set", "product", "brand", "card set"],
  cardNumber: ["card #", "card no", "card number", "#", "number"],
  parallel: ["parallel", "variation", "variant", "insert"],
  team: ["team", "nfl team"],
  grade: ["grade", "card grade"],
  grader: ["grader", "grading company", "grading service"],
  quantity: ["qty", "quantity", "count"],
  purchasePrice: ["purchase price", "cost", "price paid", "paid"],
  value: ["market value", "value", "current value", "estimated value"],
  lastSale: ["last sale", "last sold", "recent sale"],
  avg30: ["30-day avg", "30 day avg", "30-day average", "30 day average"],
  image: ["image url", "image", "photo url", "photo", "picture", "card image"],
  serial: ["serial", "serial #", "serial number", "numbered"],
  notes: ["notes", "note", "comments"]
};

let rows = [];
let mapping = {};

const $ = (id) => document.getElementById(id);
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const escapeHtml = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function mapHeaders(headers) {
  const result = {};
  for (const [key, aliases] of Object.entries(ALIASES)) {
    result[key] = headers.find(h => aliases.includes(norm(h))) || "";
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
  return n ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : "—";
}

function quantity(row) {
  const q = parseInt(field(row, "quantity"), 10);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

function titleFor(row) {
  return field(row, "player") || field(row, "set") || Object.values(row).find(Boolean) || "Untitled Card";
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

function imageHtml(row, detail=false) {
  const src = field(row, "image");
  const alt = escapeHtml(cardQuery(row) || titleFor(row));
  if (src && /^https?:\/\//i.test(src)) {
    return `<img class="${detail ? "" : "card-image"}" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;card-placeholder&quot;><strong>${escapeHtml(initials(titleFor(row)))}</strong></div>'">`;
  }
  return `<div class="card-placeholder"><strong>${escapeHtml(initials(titleFor(row)))}</strong></div>`;
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join("").toUpperCase() || "FC";
}

function metaLine(row) {
  return [field(row, "year"), field(row, "set")].filter(Boolean).join(" · ");
}

function subtitle(row) {
  const bits = [];
  if (field(row, "cardNumber")) bits.push(`#${field(row, "cardNumber")}`);
  if (field(row, "parallel")) bits.push(field(row, "parallel"));
  if (field(row, "team")) bits.push(field(row, "team"));
  return bits.join(" · ") || "Football Card";
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

  $("results-count").textContent = `${filtered.reduce((sum,r)=>sum+quantity(r),0)} card${filtered.length===1?"":"s"} · ${filtered.length} catalog entr${filtered.length===1?"y":"ies"}`;
  $("catalog").innerHTML = filtered.map((row) => {
    const realIndex = rows.indexOf(row);
    const grade = gradeText(row);
    return `
      <article class="card">
        <div class="card-image-wrap">
          ${imageHtml(row)}
          ${grade ? `<span class="grade-badge">${escapeHtml(grade)}</span>` : ""}
        </div>
        <div class="card-body">
          <div class="card-meta">${escapeHtml(metaLine(row) || "Football Card")}</div>
          <h3 class="card-name">${escapeHtml(titleFor(row))}</h3>
          <div class="card-subtitle">${escapeHtml(subtitle(row))}</div>
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
  const players = new Set(rows.map(r => field(r,"player")).filter(Boolean)).size;
  const totalValue = rows.reduce((sum,r) => sum + moneyNumber(field(r,"value")) * quantity(r), 0);
  const totalCost = rows.reduce((sum,r) => sum + moneyNumber(field(r,"purchasePrice")) * quantity(r), 0);

  $("stat-cards").textContent = cardCount.toLocaleString();
  $("stat-players").textContent = players ? players.toLocaleString() : "—";
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
        <div class="eyebrow">${escapeHtml(metaLine(row) || "COLLECTION CARD")}</div>
        <h2>${escapeHtml(titleFor(row))}</h2>
        <div class="detail-subtitle">${escapeHtml(subtitle(row))}</div>

        <div class="detail-table">
          ${fields.map(([k,v]) => `
            <div class="detail-field">
              <span>${escapeHtml(k)}</span>
              <strong>${escapeHtml(v)}</strong>
            </div>`).join("")}
        </div>

        <div class="detail-actions">
          <a class="primary" href="${ebaySold}" target="_blank" rel="noopener">Recent eBay sales</a>
          <a href="${googleImages}" target="_blank" rel="noopener">Find card image</a>
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
    const response = await fetch(`${CONFIG.dataEndpoint}?ts=${Date.now()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
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
    $("status-line").textContent = `${rows.length.toLocaleString()} catalog entries loaded from your Google Sheet.`;
    $("last-updated").textContent = `Last refreshed ${new Date().toLocaleString()}`;
  } catch (err) {
    console.error(err);
    rows = [];
    $("catalog").innerHTML = "";
    $("sync-text").textContent = "Setup needed";
    $("status-line").textContent = "The website is ready; the Sheet connection needs to be enabled.";
    $("error-message").textContent = err.message;
    $("error-state").classList.remove("hidden");
    $("stat-cards").textContent = "—";
    $("stat-players").textContent = "—";
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
