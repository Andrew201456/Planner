import { validKey, validRecord, validVersion } from "../dist/model.mjs";

const mirror = "https://andrew-imerisio-planner.flutedcloth5.chatgpt.site";
const ready = new WeakMap();
const table = `CREATE TABLE IF NOT EXISTS planner_records (
  planner_id TEXT NOT NULL, record_key TEXT NOT NULL, version TEXT NOT NULL,
  data TEXT, PRIMARY KEY (planner_id, record_key)
) WITHOUT ROWID`;
const deviceTable = `CREATE TABLE IF NOT EXISTS planner_devices (
  device_id TEXT PRIMARY KEY, planner_id TEXT NOT NULL
) WITHOUT ROWID`;
const codeTable = `CREATE TABLE IF NOT EXISTS planner_pairings (
  code_hash TEXT PRIMARY KEY, planner_id TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_by TEXT
) WITHOUT ROWID`;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function prepare(db) {
  if (!ready.has(db)) ready.set(db, Promise.resolve().then(() => db.batch([
    db.prepare(table), db.prepare(deviceTable), db.prepare(codeTable),
    db.prepare("CREATE INDEX IF NOT EXISTS planner_pairing_expiry ON planner_pairings(expires_at)")
  ])).catch(error => {
    ready.delete(db);
    throw error;
  }));
  return ready.get(db);
}

function unpack(row) {
  return { key: row.record_key, version: row.version, value: row.data === null ? null : JSON.parse(row.data) };
}

async function readRecord(request, limit = 512 * 1024) {
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

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function invite(db, owner) {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), n => alphabet[n & 31]).join("");
  const now = Date.now(), expires = now + 600000;
  await db.batch([
    db.prepare("DELETE FROM planner_pairings WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO planner_pairings (code_hash, planner_id, expires_at) VALUES (?, ?, ?)")
      .bind(await digest("pair:" + code), owner, expires)
  ]);
  return { code, expires };
}

async function redeem(db, input, owner, device, json) {
  if (!input || typeof input.code !== "string" || !/^[A-HJ-NP-Z2-9]{12}$/.test(input.code) ||
      typeof input.newToken !== "string" || !/^[0-9a-f]{64}$/.test(input.newToken)) return json({ error: "invalid_code" }, 400);
  const code = await digest("pair:" + input.code);
  const recipient = await digest(input.newToken);
  if (recipient === device) return json({ error: "device" }, 400);
  // Claim and grant the new device access in a single D1 transaction. Retries can use the same credential.
  const now = Date.now();
  const [, , receipt] = await db.batch([
    db.prepare(`UPDATE planner_pairings SET claimed_by = ? WHERE code_hash = ? AND expires_at > ?
      AND claimed_by IS NULL`).bind(recipient, code, now),
    db.prepare(`INSERT OR IGNORE INTO planner_devices (device_id, planner_id)
      SELECT ?, planner_id FROM planner_pairings WHERE code_hash = ? AND claimed_by = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM planner_records WHERE planner_id = ?)`).bind(recipient, code, recipient, now, recipient),
    db.prepare(`SELECT p.planner_id FROM planner_pairings p JOIN planner_devices d
      ON d.device_id = p.claimed_by AND d.planner_id = p.planner_id
      WHERE p.code_hash = ? AND p.claimed_by = ? AND p.expires_at > ?`).bind(code, recipient, now)
  ]);
  if (!receipt.results.length) return json({ error: "invalid_code" }, 409);
  return json({ samePlanner: receipt.results[0].planner_id === owner });
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
      headers["Access-Control-Allow-Methods"] = "GET, PUT, POST, OPTIONS";
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        await prepare(env.DB);
        await env.DB.prepare("SELECT record_key FROM planner_records LIMIT 0").all();
        return json({ ok: true, storage: "D1" });
      }
      if (!["/api/planner", "/api/pairing", "/api/pairing/redeem"].includes(url.pathname)) return json({ error: "route" }, 404);
      const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "")?.[1];
      if (!token) return json({ error: "authorization" }, 401);
      const device = await digest(token);
      await prepare(env.DB);
      // Existing browsers keep their original namespace. Paired devices use the inviter's namespace.
      const owner = await env.DB.prepare("SELECT planner_id FROM planner_devices WHERE device_id = ?")
        .bind(device).first("planner_id") ?? device;
      if (url.pathname !== "/api/planner") {
        if (request.method !== "POST") return json({ error: "method" }, 405);
        if (url.pathname === "/api/pairing") return json(await invite(env.DB, owner));
        return await redeem(env.DB, await readRecord(request, 2048), owner, device, json);
      }
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
      const checkBase = Object.hasOwn(entry, "base");
      if (checkBase && entry.base !== null && !validVersion(entry.base)) return json({ error: "version" }, 400);
      // A retried write, including a late offline edit, cannot undo a newer write or deletion.
      const [, current] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO planner_records (planner_id, record_key, version, data)
          VALUES (?, ?, ?, ?) ON CONFLICT(planner_id, record_key) DO UPDATE SET
          version = excluded.version, data = excluded.data WHERE excluded.version > planner_records.version
          AND (? = 0 OR planner_records.version = ?)`)
          .bind(owner, entry.key, entry.version, entry.value === null ? null : JSON.stringify(entry.value),
            checkBase ? 1 : 0, entry.base ?? null),
        env.DB.prepare("SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key = ?")
          .bind(owner, entry.key)
      ]);
      return json(unpack(current.results[0]));
    } catch {
      return json({ error: "storage_unavailable" }, 503);
    }
  }
};
