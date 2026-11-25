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
const account = "account:markarv";
const loginTable = `CREATE TABLE IF NOT EXISTS planner_login_limits (
  client_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
) WITHOUT ROWID`;
const sessionDays = 30;

function prepare(db) {
  if (!ready.has(db)) ready.set(db, Promise.resolve().then(() => db.batch([
    db.prepare(table), db.prepare(deviceTable), db.prepare(loginTable)
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

function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signature(password, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode("planner-account-v1:" + message));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2,"0")).join("");
}

async function issueSession(password) {
  const expires = Date.now() + sessionDays * 86400000;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,"0")).join("");
  const body = expires + "." + nonce;
  return body + "." + await signature(password, body);
}

async function verifySession(password, request) {
  const match = /^Bearer (\d{13})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
  if (!match || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + sessionDays * 86400000) return false;
  return equal(match[3], await signature(password, match[1] + "." + match[2]));
}

async function login(request, env, json) {
  const input = await readRecord(request, 4096);
  if (!input || typeof input.username !== "string" || typeof input.password !== "string" || input.password.length > 1024) return json({error:"credentials"}, 400);
  const id = await digest("planner-login:" + (request.headers.get("CF-Connecting-IP") || "local"));
  const now = Date.now(), cutoff = now - 600000;
  const { results } = await env.DB.prepare(`INSERT INTO planner_login_limits (client_id,window_start,attempts)
    VALUES (?,?,1) ON CONFLICT(client_id) DO UPDATE SET
    attempts=CASE WHEN window_start <= ? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    RETURNING attempts`).bind(id, now, cutoff, cutoff).all();
  if (results[0].attempts > 10) return json({error:"rate_limit"},429);
  if (input.username.trim().toLowerCase() !== "markarv" ||
      !equal(await digest(input.password), await digest(env.PASSWORD))) return json({error:"credentials"},401);
  await env.DB.prepare("DELETE FROM planner_login_limits WHERE client_id = ?").bind(id).run();
  return json({token: await issueSession(env.PASSWORD), username:"markarv"});
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
      if (!["/api/planner", "/api/login", "/api/session", "/api/migrate", "/api/diagnostics"].includes(url.pathname)) return json({error:"route"},404);
      if (typeof env.PASSWORD !== "string" || !env.PASSWORD) return json({error:"password_not_configured"},503);
      await prepare(env.DB);
      if (url.pathname === "/api/login") {
        return request.method === "POST" ? await login(request,env,json) : json({error:"method"},405);
      }
      if (!await verifySession(env.PASSWORD, request)) return json({error:"authorization"},401);
      const owner = account;
      if (url.pathname === "/api/session") return request.method === "GET" ? json({ok:true,username:"markarv"}) : json({error:"method"},405);
      if (url.pathname === "/api/migrate") {
        if (request.method !== "POST") return json({error:"method"},405);
        const input = await readRecord(request,2048);
        if (!input || typeof input.legacyToken !== "string" || !/^[0-9a-f]{64}$/.test(input.legacyToken)) return json({error:"legacy_token"},400);
        const device = await digest(input.legacyToken);
        const previous = await env.DB.prepare("SELECT planner_id FROM planner_devices WHERE device_id = ?").bind(device).first("planner_id") ?? device;
        // Retain the original namespace. Only replace untouched seed notebooks; never overwrite account edits or tombstones.
        await env.DB.prepare(`INSERT INTO planner_records (planner_id,record_key,version,data)
          SELECT ?,record_key,version,data FROM planner_records WHERE planner_id = ?
          ON CONFLICT(planner_id,record_key) DO UPDATE SET version=excluded.version,data=excluded.data
          WHERE planner_records.version = '0000000000000000-00000000-0000-4000-8000-000000000000'
          AND excluded.version > planner_records.version`).bind(owner,previous).run();
        return json({ok:true});
      }
      if (url.pathname === "/api/diagnostics") {
        if (request.method !== "GET") return json({ error: "method" }, 405);
        const { results } = await env.DB.prepare(`SELECT
          COUNT(*) AS records,
          COUNT(CASE WHEN record_key LIKE 'note:%' AND data IS NOT NULL THEN 1 END) AS notes,
          COUNT(CASE WHEN record_key LIKE 'book:%' AND data IS NOT NULL THEN 1 END) AS books
          FROM planner_records WHERE planner_id = ?`).bind(owner).all();
        return json({ ok: true, storage: "D1", records: results[0].records,
          notes: results[0].notes, books: results[0].books });
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
          AND ? = 0 AND (? = 0 OR planner_records.version = ?)`)
          .bind(owner, entry.key, entry.version, entry.value === null ? null : JSON.stringify(entry.value),
            entry.importOnly === true ? 1 : 0, checkBase ? 1 : 0, entry.base ?? null),
        env.DB.prepare("SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key = ?")
          .bind(owner, entry.key)
      ]);
      return json(unpack(current.results[0]));
    } catch {
      return json({ error: "storage_unavailable" }, 503);
    }
  }
};
