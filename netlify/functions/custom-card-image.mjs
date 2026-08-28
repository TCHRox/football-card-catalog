import { getStore } from "@netlify/blobs";

const STORE_NAME = "football-card-custom-images";
const INDEX_KEY = "__index__";
const MAX_FILE_SIZE = 4_750_000;

function store() {
  return getStore({
    name: STORE_NAME,
    consistency: "strong"
  });
}

function blobKey(cardKey) {
  return `images/${Buffer.from(cardKey, "utf8").toString("base64url")}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function loadIndex(s) {
  return await s.get(INDEX_KEY, { type: "json" }) || {};
}

function authorized(password) {
  const configured = process.env.CARD_CATALOG_ADMIN_PASSWORD || "";
  if (!configured) return { ok: false, reason: "not-configured" };
  return { ok: password === configured, reason: "wrong-password" };
}

export default async (request) => {
  try {
    const s = store();
    const url = new URL(request.url);

    if (request.method === "GET" && url.searchParams.get("index") === "1") {
      const index = await loadIndex(s);
      return json({ index });
    }

    if (request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!key) return json({ error: "Missing card key." }, 400);

      const entry = await s.getWithMetadata(blobKey(key), {
        type: "arrayBuffer"
      });

      if (!entry || !entry.data) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(entry.data, {
        status: 200,
        headers: {
          "content-type": entry.metadata?.contentType || "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const key = String(form.get("key") || "");
      const password = String(form.get("password") || "");
      const file = form.get("file");

      const auth = authorized(password);
      if (!auth.ok) {
        if (auth.reason === "not-configured") {
          return json({
            error: "CARD_CATALOG_ADMIN_PASSWORD is not configured in Netlify."
          }, 503);
        }
        return json({ error: "Incorrect admin password." }, 401);
      }

      if (!key) return json({ error: "Missing card key." }, 400);
      if (!(file instanceof File)) return json({ error: "Missing image file." }, 400);
      if (!String(file.type || "").startsWith("image/")) {
        return json({ error: "Only image uploads are allowed." }, 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        return json({ error: "Image is too large after resizing." }, 413);
      }

      const updatedAt = Date.now();
      const contentType = file.type || "image/jpeg";

      await s.set(blobKey(key), await file.arrayBuffer(), {
        metadata: {
          contentType,
          updatedAt
        }
      });

      const index = await loadIndex(s);
      index[key] = {
        version: updatedAt,
        updatedAt,
        contentType
      };
      await s.setJSON(INDEX_KEY, index);

      return json({
        ok: true,
        meta: index[key]
      });
    }

    if (request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || "");
      const password = String(body.password || "");

      const auth = authorized(password);
      if (!auth.ok) {
        if (auth.reason === "not-configured") {
          return json({
            error: "CARD_CATALOG_ADMIN_PASSWORD is not configured in Netlify."
          }, 503);
        }
        return json({ error: "Incorrect admin password." }, 401);
      }

      if (!key) return json({ error: "Missing card key." }, 400);

      await s.delete(blobKey(key));

      const index = await loadIndex(s);
      delete index[key];
      await s.setJSON(INDEX_KEY, index);

      return json({ ok: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
};
