import { validKey, validRecord, validVersion } from "../dist/model.mjs";

const mirror = "https://andrew-imerisio-planner.flutedcloth5.chatgpt.site";
const ready = new WeakMap();
const table = `CREATE TABLE IF NOT EXISTS planner_records (
  planner_id TEXT NOT NULL, record_key TEXT NOT NULL, version TEXT NOT NULL,
  data TEXT, PRIMARY KEY (planner_id, record_key)
) WITHOUT ROWID`;

function prepare(db) {
  if (!ready.has(db)) ready.set(db, db.prepare(table).run().catch(error => {
    ready.delete(db);
    throw error;
  }));
  return ready.get(db);
}

function unpack(row) {
  return { key: row.record_key, version: row.version, value: row.data === null ? null : JSON.parse(row.data) };
}

async function readRecord(request) {
  const limit = 512 * 1024;
  if (!request.body || Number(request.headers.get("Content-Length")) > limit) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); return null; }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const origin = request.headers.get("Origin");
    const headers = { "Cache-Control": "no-store", "Vary": "Origin" };
    const json = (data, status = 200) => Response.json(data, { status, headers });
    if (origin && origin !== url.origin && origin !== mirror) return json({ error: "origin" }, 403);
    if (origin === mirror) {
      headers["Access-Control-Allow-Origin"] = mirror;
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      headers["Access-Control-Allow-Methods"] = "GET, PUT, OPTIONS";
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        await prepare(env.DB);
        await env.DB.prepare("SELECT record_key FROM planner_records LIMIT 0").all();
        return json({ ok: true, storage: "D1" });
      }
      if (url.pathname !== "/api/planner") return json({ error: "route" }, 404);
      const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "")?.[1];
      if (!token) return json({ error: "authorization" }, 401);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const owner = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      await prepare(env.DB);
      if (request.method === "GET") {
        const after = url.searchParams.get("after") || "";
        if (after && !validKey(after)) return json({ error: "cursor" }, 400);
        const { results } = await env.DB.prepare(
          "SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key > ? ORDER BY record_key LIMIT 12"
        ).bind(owner, after).all();
        return json({ records: results.map(unpack), next: results.length === 12 ? results.at(-1).record_key : null });
      }
      if (request.method !== "PUT") return json({ error: "method" }, 405);
      const entry = await readRecord(request);
      if (!entry || !validVersion(entry.version) || !validRecord(entry.key, entry.value)) return json({ error: "record" }, 400);
      // A retried write, including a late offline edit, cannot undo a newer write or deletion.
      const [, current] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO planner_records (planner_id, record_key, version, data)
          VALUES (?, ?, ?, ?) ON CONFLICT(planner_id, record_key) DO UPDATE SET
          version = excluded.version, data = excluded.data WHERE excluded.version > planner_records.version`)
          .bind(owner, entry.key, entry.version, entry.value === null ? null : JSON.stringify(entry.value)),
        env.DB.prepare("SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key = ?")
          .bind(owner, entry.key)
      ]);
      return json(unpack(current.results[0]));
    } catch {
      return json({ error: "storage_unavailable" }, 503);
    }
  }
};
