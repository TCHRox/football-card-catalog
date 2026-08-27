// Netlify Function: live Google Sheets -> JSON
// Your Google Sheet ID is already entered below.
const SHEET_ID = "1ZelpNWlXQHIzmDCVSDv1TMYEuh-eua6SKUtsESqlmeI";

// 0 is usually the first tab. If your collection is on another tab,
// open that tab in Google Sheets and copy the number after "#gid=" in the URL.
const SHEET_GID = "0";

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export default async () => {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!response.ok) {
      throw new Error(`Google Sheets returned ${response.status}. Make sure the sheet is shared as "Anyone with the link — Viewer".`);
    }

    const csv = await response.text();

    if (/<!doctype html|<html/i.test(csv.slice(0, 500))) {
      throw new Error('Google returned a sign-in page instead of spreadsheet data. Change the Sheet sharing setting to "Anyone with the link — Viewer".');
    }

    const matrix = parseCSV(csv).filter(r => r.some(c => String(c).trim() !== ""));
    if (!matrix.length) throw new Error("No rows were returned from the selected Sheet tab.");

    let headers = matrix[0].map((h, i) => String(h).trim() || `Column ${i + 1}`);
    // Ensure duplicate column names don't overwrite each other.
    const seen = {};
    headers = headers.map(h => {
      seen[h] = (seen[h] || 0) + 1;
      return seen[h] === 1 ? h : `${h} ${seen[h]}`;
    });

    const rows = matrix.slice(1).map(cols => {
      const obj = {};
      headers.forEach((header, i) => obj[header] = cols[i] ?? "");
      return obj;
    }).filter(obj => Object.values(obj).some(v => String(v).trim() !== ""));

    return new Response(JSON.stringify({
      sheetId: SHEET_ID,
      gid: SHEET_GID,
      headers,
      rows,
      fetchedAt: new Date().toISOString()
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
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
