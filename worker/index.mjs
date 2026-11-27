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
const legacyAccount = "account:markarv";
// A separate high-entropy signing key prevents a short PIN from being used to forge sessions.
function marmichAuth(env) {
  try {
    const value = JSON.parse(env.MARMICH_AUTH || "null");
    if (typeof value?.password !== "string" || !value.password || value.password.length > 1024 || !/^[0-9a-f]{64}$/.test(value.sessionKey || "")) return null;
    return value;
  } catch { return null; }
}
const loginTable = `CREATE TABLE IF NOT EXISTS planner_login_limits (
  client_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
) WITHOUT ROWID`;
const sessionDays = 30;
const accountsTable = `CREATE TABLE IF NOT EXISTS planner_accounts (
  username TEXT PRIMARY KEY, salt TEXT, verifier TEXT, session_key TEXT,
  created_at INTEGER NOT NULL, deleted_at INTEGER
) WITHOUT ROWID`;
const activityTable = `CREATE TABLE IF NOT EXISTS planner_account_activity (
  username TEXT PRIMARY KEY, last_login INTEGER NOT NULL, ip TEXT
) WITHOUT ROWID`;
const validUsername = name => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(name);
const cleanUsername = name => typeof name === "string" ? name.trim().toLowerCase() : "";
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2,"0")).join("");
const accountRow = (db,name) => db.prepare("SELECT username,salt,verifier,session_key,created_at,deleted_at FROM planner_accounts WHERE username=?").bind(name).first();
async function verifier(password,salt){
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  const bytes=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:enc.encode(salt),iterations:100000},key,256);
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
async function gate(db,id,limit=10){
  const now=Date.now(),cutoff=now-600000;
  const {results}=await db.prepare(`INSERT INTO planner_login_limits (client_id,window_start,attempts)
    VALUES (?,?,1) ON CONFLICT(client_id) DO UPDATE SET
    attempts=CASE WHEN window_start <= ? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    RETURNING attempts`).bind(id,now,cutoff,cutoff).all();
  return results[0].attempts<=limit;
}
async function logLogin(db,username,request,managedKey=null){
  const raw=request.headers.get("CF-Connecting-IP")||"";
  const ip=/^[0-9a-fA-F:.]{3,45}$/.test(raw)?raw:null;
  try {
    await db.prepare(`INSERT INTO planner_account_activity(username,last_login,ip)
      SELECT ?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM planner_accounts WHERE username=? AND deleted_at IS NULL AND session_key=?)
      ON CONFLICT(username) DO UPDATE SET last_login=excluded.last_login,ip=excluded.ip
      WHERE excluded.last_login>=planner_account_activity.last_login`).bind(username,Date.now(),ip,managedKey,username,managedKey).run();
  } catch { /* Activity logging must not interrupt an existing account's login. */ }
}
async function admin(request,env,json){
  const password=env.PLANNER_ADMIN_PASSWORD;
  if(typeof password!=="string"||!password||password.length>256)return json({error:"admin_not_configured"},503);
  if(request.method!=="POST")return json({error:"method"},405);
  const origin=request.headers.get("Origin");
  if(origin&&origin!==new URL(request.url).origin)return json({error:"origin"},403);
  const input=await readRecord(request,8192);
  if(!input||typeof input.adminPassword!=="string"||input.adminPassword.length>256)return json({error:"credentials"},400);
  const ip=await digest("planner-admin:"+ (request.headers.get("CF-Connecting-IP")||"local"));
  if(!await gate(env.DB,ip,30)||!await gate(env.DB,"planner-admin-global",300))return json({error:"rate_limit"},429);
  if(!equal(await digest(input.adminPassword),await digest(password)))return json({error:"credentials"},401);
  const action=input.action, db=env.DB;
  if(action==="list"){
    const {results}=await db.prepare(`SELECT a.username,a.created_at,l.last_login,l.ip
      FROM planner_accounts a LEFT JOIN planner_account_activity l ON l.username=a.username
      WHERE a.deleted_at IS NULL ORDER BY a.username LIMIT 500`).all();
    const legacy=["markarv"];
    if(marmichAuth(env))legacy.push("marmich");
    const accounts=[];
    for(const username of legacy){
      const activity=await db.prepare("SELECT last_login,ip FROM planner_account_activity WHERE username=?").bind(username).first();
      accounts.push({username,protected:true,created_at:null,last_login:activity?.last_login??null,ip:activity?.ip??null});
    }
    for(const row of results)accounts.push({...row,protected:false});
    return json({accounts,truncated:results.length===500});
  }
  const username=cleanUsername(input.username);
  if(!validUsername(username))return json({error:"username"},400);
  if(username==="markarv"||(username==="marmich"&&marmichAuth(env)))return json({error:"protected"},403);
  if(action==="create"||action==="password"){
    if(typeof input.password!=="string"||input.password.length<4||input.password.length>128)return json({error:"password"},400);
    const salt=randomHex(16),hash=await verifier(input.password,salt),key=randomHex(32);
    if(action==="create"){
      // A name with existing legacy data or a deletion tombstone cannot be claimed.
      const result=await db.prepare(`INSERT INTO planner_accounts(username,salt,verifier,session_key,created_at)
        SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM planner_records WHERE planner_id=?)
        ON CONFLICT(username) DO NOTHING`).bind(username,salt,hash,key,Date.now(),"account:"+username).run();
      return result.meta.changes===1?json({ok:true},201):json({error:"exists"},409);
    }
    const result=await db.prepare("UPDATE planner_accounts SET salt=?,verifier=?,session_key=? WHERE username=? AND deleted_at IS NULL").bind(salt,hash,key,username).run();
    return result.meta.changes===1?json({ok:true}):json({error:"not_found"},404);
  }
  if(action==="delete"){
    if(input.confirmed!==true||input.confirmUsername!==username)return json({error:"confirmation"},400);
    const row=await accountRow(db,username);
    if(!row||row.deleted_at!==null)return json({error:"not_found"},404);
    // Atomic tombstone, data deletion and activity deletion. Username is never recycled.
    await db.batch([
      db.prepare("UPDATE planner_accounts SET deleted_at=?,salt=NULL,verifier=NULL,session_key=NULL WHERE username=? AND deleted_at IS NULL").bind(Date.now(),username),
      db.prepare("DELETE FROM planner_records WHERE planner_id=? AND EXISTS(SELECT 1 FROM planner_accounts WHERE username=? AND deleted_at IS NOT NULL)").bind("account:"+username,username),
      db.prepare("DELETE FROM planner_account_activity WHERE username=?").bind(username)
    ]);
    return json({ok:true});
  }
  return json({error:"action"},400);
}

function prepare(db) {
  if (!ready.has(db)) ready.set(db, Promise.resolve().then(() => db.batch([
    db.prepare(table), db.prepare(deviceTable), db.prepare(loginTable), db.prepare(accountsTable), db.prepare(activityTable)
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

async function identifySession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const managed = /^Bearer v3\.([a-z0-9][a-z0-9_-]{1,31})\.(\d{13})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(auth);
  if(managed){
    const [,username,expires,nonce,sig]=managed;
    if(username==="markarv"||Number(expires)<=Date.now()||Number(expires)>Date.now()+sessionDays*86400000)return null;
    const row=await accountRow(env.DB,username);
    if(!row||row.deleted_at!==null||!row.session_key)return null;
    return equal(sig,await signature(row.session_key,"v3."+username+"."+expires+"."+nonce))?{username,managedKey:row.session_key}:null;
  }
  const match = /^Bearer v2\.marmich\.(\d{13})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(auth);
  if (match) {
    const config = marmichAuth(env);
    if (!config || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + sessionDays * 86400000) return null;
    const expected = await signature(config.sessionKey, "v2.marmich." + match[1] + "." + match[2]);
    return equal(match[3],expected) ? {username:"marmich",managedKey:null} : null;
  }
  return typeof env.PASSWORD === "string" && env.PASSWORD && await verifySession(env.PASSWORD, request) ? {username:"markarv",managedKey:null} : null;
}
async function issueMarmichSession(key) {
  const expires = Date.now() + sessionDays * 86400000;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,"0")).join("");
  const body = "v2.marmich." + expires + "." + nonce;
  return body + "." + await signature(key,body);
}

async function login(request, env, json) {
  const input = await readRecord(request, 4096);
  if (!input || typeof input.username !== "string" || typeof input.password !== "string" || input.password.length > 1024) return json({error:"credentials"}, 400);
  const id = await digest("planner-login:" + (request.headers.get("CF-Connecting-IP") || "local"));
  if(!await gate(env.DB,id))return json({error:"rate_limit"},429);
  const username=cleanUsername(input.username);
  if(!validUsername(username))return json({error:"credentials"},401);
  const extra=username==="marmich"&&input.accountVersion>=2?marmichAuth(env):null;
  let token,managedKey=null;
  if(username==="markarv"||extra){
    const password=extra?extra.password:env.PASSWORD;
    if(extra&&!await gate(env.DB,await digest("planner-login-account:"+username)))return json({error:"rate_limit"},429);
    if(typeof password!=="string"||!password||!equal(await digest(input.password),await digest(password)))return json({error:"credentials"},401);
    token=extra?await issueMarmichSession(extra.sessionKey):await issueSession(password);
  }else{
    if(input.accountVersion!==3)return json({error:"credentials"},401);
    const row=await accountRow(env.DB,username);
    if(!row||row.deleted_at!==null||!row.session_key)return json({error:"credentials"},401);
    if(!await gate(env.DB,await digest("planner-login-account:"+username)))return json({error:"rate_limit"},429);
    if(!equal(await verifier(input.password,row.salt),row.verifier))return json({error:"credentials"},401);
    managedKey=row.session_key;
    const body="v3."+username+"."+(Date.now()+sessionDays*86400000)+"."+randomHex(32);
    token=body+"."+await signature(managedKey,body);
  }
  await env.DB.prepare("DELETE FROM planner_login_limits WHERE client_id = ?").bind(id).run();
  if(username!=="markarv")await env.DB.prepare("DELETE FROM planner_login_limits WHERE client_id=?").bind(await digest("planner-login-account:"+username)).run();
  await logLogin(env.DB,username,request,managedKey);
  return json({token,username});
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
      if (!["/api/planner", "/api/login", "/api/session", "/api/migrate", "/api/diagnostics", "/api/admin"].includes(url.pathname)) return json({error:"route"},404);
      await prepare(env.DB);
      if(url.pathname==="/api/admin")return await admin(request,env,json);
      if (url.pathname === "/api/login") {
        return request.method === "POST" ? await login(request,env,json) : json({error:"method"},405);
      }
      const identity = await identifySession(env, request);
      if (!identity) return json({error:"authorization"},401);
      const {username,managedKey}=identity;
      const owner = username === "markarv" ? legacyAccount : "account:"+username;
      if (url.pathname === "/api/session") return request.method === "GET" ? json({ok:true,username}) : json({error:"method"},405);
      if (url.pathname === "/api/migrate") {
        if (username !== "markarv") return json({error:"authorization"},403);
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
          "SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key > ? AND (? = 1 OR record_key NOT LIKE 'food:%') ORDER BY record_key LIMIT 12"
        ).bind(owner, after, url.searchParams.get("types")==="all"?1:0).all();
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
          SELECT ?, ?, ?, ? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM planner_accounts WHERE username=? AND deleted_at IS NULL AND session_key=?) ON CONFLICT(planner_id, record_key) DO UPDATE SET
          version = excluded.version, data = excluded.data WHERE excluded.version > planner_records.version
          AND ? = 0 AND (? = 0 OR planner_records.version = ?)`)
          .bind(owner, entry.key, entry.version, entry.value === null ? null : JSON.stringify(entry.value),
            managedKey, username, managedKey, entry.importOnly === true ? 1 : 0, checkBase ? 1 : 0, entry.base ?? null),
        env.DB.prepare("SELECT record_key, version, data FROM planner_records WHERE planner_id = ? AND record_key = ?")
          .bind(owner, entry.key)
      ]);
      if(managedKey){const row=await accountRow(env.DB,username);if(!row||row.deleted_at!==null||row.session_key!==managedKey)return json({error:"authorization"},401);}
      if(!current.results[0])return json({error:"authorization"},401);
      return json(unpack(current.results[0]));
    } catch {
      return json({ error: "storage_unavailable" }, 503);
    }
  }
};
