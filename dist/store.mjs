import { presets, validRecord, validVersion } from "./model.mjs";

const seedVersion = "0000000000000000-00000000-0000-4000-8000-000000000000";
const channelName = "planner.v2.changes";
const endpoint = location.hostname === "andrew-imerisio-planner.flutedcloth5.chatgpt.site"
  ? "https://planner.asmylonas8.workers.dev/api/" : "/api/";

const sessionKey = "planner.account.session.v1";
export function accountName(token) {
  const managed=/^v3\.([a-z0-9][a-z0-9_-]{1,31})\.\d{13}\.[0-9a-f]{64}\.[0-9a-f]{64}$/.exec(token||"");
  if(managed && managed[1]!=="markarv")return managed[1];
  if (/^v2\.marmich\.\d{13}\.[0-9a-f]{64}\.[0-9a-f]{64}$/.test(token || "")) return "marmich";
  if (/^\d{13}\.[0-9a-f]{64}\.[0-9a-f]{64}$/.test(token || "")) return "markarv";
  return null;
}
function storedSession() {
  for (const type of ["sessionStorage","localStorage"]) {
    try { const token=window[type].getItem(sessionKey); if(token)return token; } catch {}
  }
  return null;
}
function remember(token,persistent) {
  // Do not retain an old persistent session after an unchecked login.
  signOut();
  try { window[persistent?"localStorage":"sessionStorage"].setItem(sessionKey,token); }
  catch { try { sessionStorage.setItem(sessionKey,token); } catch {} }
}
export function signOut() {
  for (const type of ["sessionStorage","localStorage"]) {
    try { window[type].removeItem(sessionKey); } catch {}
  }
}
async function authRequest(path, options = {}, token) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(),15000);
  try {
    const response = await fetch(endpoint+path, {
      ...options, signal:control.signal, cache:"no-store", credentials:"omit",
      headers:{...(token && {Authorization:"Bearer "+token}), ...(options.body && {"Content-Type":"application/json"})}
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) {
      const error = new Error(response.status===401 ? "Λάθος username ή password." :
        response.status===429 ? "Πολλές προσπάθειες. Δοκίμασε ξανά σε 10 λεπτά." :
        data.error==="password_not_configured" ? "Η σύνδεση δεν έχει ρυθμιστεί ακόμη." :
        "Η σύνδεση με τον διακομιστή δεν είναι διαθέσιμη.");
      error.status = response.status; throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}
export async function signIn(username,password,persistent=true,accountVersion=1) {
  const data = await authRequest("login",{method:"POST",body:JSON.stringify({username,password,accountVersion})});
  if (!accountName(data.token) || accountName(data.token)!==data.username || (accountVersion!==3 && data.token.startsWith("v3.")) || (accountVersion<2 && data.username!=="markarv")) throw new Error("Η σύνδεση δεν επιβεβαιώθηκε.");
  remember(data.token,persistent); return data.token;
}
export async function restoreSession(accountVersion=1) {
  const token=storedSession();
  if (!token || (accountVersion!==3 && token.startsWith("v3.")) || (accountVersion<2 && accountName(token)!=="markarv")) return null;
  try {
    const data=await authRequest("session",{},token);
    if (data.ok===true && accountName(token) && data.username===accountName(token)) return token;
  } catch(error) { if (error.status!==401) throw error; }
  signOut(); return null;
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(db, names, mode, work) {
  const tx = db.transaction(names, mode);
  let timedOut = false;
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(timedOut ? new Error("Η αποθήκευση στη συσκευή καθυστερεί. Δοκίμασε ξανά χωρίς να κλείσεις τη φόρμα.") : tx.error || new Error("Η αλλαγή δεν αποθηκεύτηκε στη συσκευή."));
  });
  // Prevent a stuck transaction from leaving an Android form locked forever.
  const deadline = setTimeout(() => { try { timedOut = true; tx.abort(); } catch {} }, 10000);
  done.catch(() => {});
  try {
    const value = await work(tx);
    await done;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* Already closed. */ }
    await done.catch(() => {});
    if (timedOut) throw new Error("Η αποθήκευση στη συσκευή καθυστερεί. Δοκίμασε ξανά.");
    throw error;
  } finally { clearTimeout(deadline); }
}

function nextVersion(previous = seedVersion, writer = crypto.randomUUID()) {
  const time = Math.max(Date.now(), Number(previous.slice(0, 16)) + 1);
  return String(time).padStart(16, "0") + "-" + writer;
}

export function legacyEntries() {
  const entries = [];
  try {
    for (const source of Object.keys(localStorage)) {
      const match = /^planner\.v1\.(book|note)\.([A-Za-z0-9-]+)$/.exec(source);
      if (!match) continue;
      const raw = localStorage.getItem(source);
      let value;
      try { value = JSON.parse(raw); } catch { continue; }
      const key = match[1] + ":" + match[2];
      if (value && validRecord(key, value)) entries.push({ key, value, source, raw });
    }
  } catch { /* IndexedDB can be available even when localStorage is disabled. */ }
  return entries;
}

export async function openPlanner(token) {
  const account=accountName(token);
  if (!account) throw new Error("Μη έγκυρη συνεδρία.");
  const legacyOwner=account==="markarv";
  const accountChannel=legacyOwner?channelName:channelName+"."+account;
  const opening = indexedDB.open(legacyOwner?"planner.v2":"planner.v2.account."+account, 1);
  opening.onupgradeneeded = () => {
    const entries = opening.result.createObjectStore("entries", { keyPath: "key" });
    entries.createIndex("dirty", "dirty");
    opening.result.createObjectStore("settings");
  };
  const db = await result(opening);
  db.onversionchange = () => db.close();
  const legacy = legacyOwner?legacyEntries():[];
  const { legacyToken, writer, migrated } = await transact(db, ["settings", "entries"], "readwrite", async tx => {
    const settings = tx.objectStore("settings");
    const entries = tx.objectStore("entries");
    const legacyToken = legacyOwner?await result(settings.get("token")):null;
    const migrated = !!await result(settings.get("accountMigrated"));
    let writer = await result(settings.get("writer"));
    if (!writer) { writer = crypto.randomUUID(); settings.put(writer, "writer"); }
    if (!migrated && !legacyToken && !await result(entries.count())) {
      for (const value of presets) entries.put({ key: "book:" + value.id, version: seedVersion, value, dirty: 1 });
    }
    for (const { key, value } of legacy) {
      if (!await result(entries.getKey(key))) entries.put({ key, version: nextVersion(), value, dirty: 1 });
    }
    if (!legacyOwner && !migrated) settings.put(true,"accountMigrated");
    return { legacyToken, writer, migrated:!legacyOwner||migrated };
  });
  // Only remove the legacy copy after the records and their pending uploads committed together.
  for (const { source, raw } of legacy) {
    try { if (localStorage.getItem(source) === raw) localStorage.removeItem(source); } catch { /* Retry next launch. */ }
  }

  const read = fn => transact(db, "entries", "readonly", tx => result(fn(tx.objectStore("entries"))));
  const scoped = (mode, fn, session) => transact(db, ["settings", "entries"], mode, tx =>
    fn(tx.objectStore("entries"), tx.objectStore("settings")));
  const edit = (fn, session = token) => scoped("readwrite", fn, session);
  const editEntries = fn => transact(db, "entries", "readwrite", tx => fn(tx.objectStore("entries")));
  const dirty = () => read(entries => entries.index("dirty").count(1));
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(accountChannel) : null;
  let onChange = () => {}, onStatus = () => {}, onConflict = () => {};
  let running = null, manualRefresh = null, scheduled = false, timer, backoff = 2000;
  let migrationPending = !migrated;

  function notify() {
    if (channel) channel.postMessage("changed");
    else try { localStorage.setItem(accountChannel, crypto.randomUUID()); } catch { /* Refreshes on foreground. */ }
  }

  async function api(path, options, session) {
    try { return await authRequest(path,options,session); }
    catch(error) {
      if (error.status===401 && storedSession()===token) { signOut(); location.reload(); }
      throw error;
    }
  }

  async function migrate(session) {
    if (!migrationPending) return;
    if (legacyToken) {
      const response = await api("migrate",{method:"POST",body:JSON.stringify({legacyToken})},session);
      if (response.ok!==true) throw new Error("migration");
    }
    // Keep all local rows until acknowledged. Existing clean rows are only imported
    // if absent in the new account; old offline edits retain their conflict checks.
    await edit(async (entries,settings) => {
      if (await result(settings.get("accountMigrated"))) return;
      for (const row of await result(entries.getAll())) {
        if (!row.dirty || row.version===seedVersion) entries.put({...row,dirty:1,importOnly:true});
      }
      settings.put(true,"accountMigrated");
    },session);
    migrationPending=false;
  }

  async function pages(session, receive) {
    let cursor = "";
    do {
      const page = await api("planner?types=all" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""), {}, session);
      if (!Array.isArray(page.records) || (page.next && page.next <= cursor)) throw new Error("page");
      if (page.records.some(row => !row || !validVersion(row.version) || !validRecord(row.key, row.value))) throw new Error("record");
      await receive(page.records);
      if (await dirty()) return false;
      cursor = page.next;
    } while (cursor);
    return true;
  }

  async function applyRemote(records, session, sent) {
    let conflictMessage = "";
    const changed = await editEntries(async entries => {
      let changed = false;
      for (const row of records) {
        if (!row || !validVersion(row.version) || !validRecord(row.key, row.value)) throw new Error("record");
        const current = await result(entries.get(row.key));
        if (current?.importOnly && sent?.version===current.version) {
          entries.put({key:row.key,version:row.version,value:row.value,dirty:0});
          changed ||= current.version!==row.version;
          continue;
        }
        if (current?.dirty && Object.hasOwn(current, "base") && current.version !== row.version) {
          if (current.base !== null && row.version <= current.base) continue;
          if (row.version === sent?.version || (row.version.endsWith(writer) && row.version < current.version)) {
            entries.put({ ...current, base: row.version });
            continue;
          }
          // Two devices changed the same note offline. Keep the other device's version and save
          // this device's edit separately, including when the original was concurrently deleted.
          if (row.key.startsWith("note:") && current.value && JSON.stringify(current.value) !== JSON.stringify(row.value)) {
            const id = crypto.randomUUID(), value = current.value;
            const title = (value.title || "Σημείωση").slice(0, 140) + " (αντίγραφο)";
            entries.put({ key: "note:" + id, version: nextVersion(current.version, writer),
              base: null, dirty: 1, value: { ...value, id, title } });
            conflictMessage = "Η ίδια σημείωση άλλαξε σε δύο συσκευές. Κρατήθηκε και η δική σου αλλαγή ως αντίγραφο.";
          } else if (row.key.startsWith("food:") && current.value && JSON.stringify(current.value) !== JSON.stringify(row.value)) {
            const id=crypto.randomUUID(),value=current.value;
            entries.put({key:"food:"+id,version:nextVersion(current.version,writer),base:null,dirty:1,
              value:{...value,id,name:value.name.slice(0,285)+" (αντίγραφο)"}});
            conflictMessage="Η καταχώρηση φαγητού άλλαξε σε δύο συσκευές. Διατηρήθηκε και η δική σου αλλαγή ως αντίγραφο.";
          } else if (!current.value && row.value) {
            conflictMessage = "Η καταχώρηση άλλαξε σε άλλη συσκευή πριν διαγραφεί. Μπορείς να την ελέγξεις ξανά.";
          }
        } else if (current && row.version < current.version) continue;
        if (current && row.version === current.version && !current.dirty) continue;
        if (current?.version !== row.version) changed = true;
        entries.put({ key: row.key, version: row.version, value: row.value, dirty: 0 });
      }
      return changed;
    });
    if (conflictMessage) onConflict(conflictMessage);
    return changed;
  }

  async function transfer(session) {
    let wrote = false;
    try {
      if (!navigator.onLine) throw new Error("offline");
      await migrate(session);
      for (;;) {
        const pending = await read(entries => entries.index("dirty").getAll(1, 8));
        if (!pending.length) break;
        onStatus("sending");
        for (const { key, value, version, base, importOnly } of pending) {
          if (session !== token) return false;
          const row = await api("planner", { method: "PUT", body: JSON.stringify({ key, value, version, base, importOnly }) }, session);
          if (row.key !== key || (!importOnly && base === undefined && row.version < version)) throw new Error("acknowledgement");
          if (await applyRemote([row], session, { version })) { notify(); await onChange(); }
          wrote = true;
        }
      }
      // Acknowledge local uploads before fetching the rest of the account.
      // Large paginated histories on mobile must not keep the save indicator busy.
      const afterPush = await dirty();
      // Success is reported only after the full pull, not just uploaded writes.
      const complete = !afterPush && await pages(session, async records => {
        if (await applyRemote(records, session)) { notify(); await onChange(); }
      });
      const remaining = await dirty();
      scheduled ||= remaining > 0 || !complete;
      onStatus(complete && remaining === 0 ? (wrote ? "saved" : "ready") : "sending");
      backoff = 2000;
      return complete && remaining === 0;
    } catch {
      if (session !== token) return false;
      const pending = await dirty().catch(() => 1);
      onStatus(pending ? "pending" : "unavailable");
      if (navigator.onLine) {
        timer = setTimeout(sync, backoff);
        backoff = Math.min(60000, backoff * 2);
      }
      return false;
    }
  }

  function sync() {
    if (running) return running;
    clearTimeout(timer); timer = null;
    scheduled = false;
    running = transfer(token).finally(() => {
      running = null;
      if (scheduled) kick();
    });
    return running;
  }

  function kick() {
    if (running) { scheduled = true; return; }
    clearTimeout(timer);
    timer = setTimeout(sync, 50);
  }

  return {
    all: () => read(entries => entries.getAll()),
    refresh() {
      // Coalesce manual clicks, then start a fresh upload + pull cycle. A
      // previously running pull may have already passed a changed record.
      if (manualRefresh) return manualRefresh;
      manualRefresh = (async () => {
        if (running) await running;
        return await sync();
      })().finally(() => { manualRefresh = null; });
      return manualRefresh;
    },
    async diagnostics() {
      if (!await sync() || await dirty()) {
        throw new Error("Υπάρχουν αλλαγές που δεν έχουν περάσει ακόμη στη βάση. Δοκίμασε ξανά με σύνδεση.");
      }
      const stats = await api("diagnostics", {}, token);
      if (stats?.ok !== true || stats.storage !== "D1" ||
          !Number.isSafeInteger(stats.notes) || !Number.isSafeInteger(stats.books)) {
        throw new Error("Η βάση δεν επιβεβαίωσε τις αποθηκευμένες σημειώσεις.");
      }
      return stats;
    },
    async save(type, id, value, expected) {
      const key = type + ":" + id;
      if (!validRecord(key, value)) throw new Error("Έλεγξε τα στοιχεία της καταχώρησης.");
      const saved = await editEntries(async entries => {
        const current = await result(entries.get(key));
        if ((current?.version ?? null) !== expected) {
          throw new Error("Η καταχώρηση άλλαξε σε άλλη συσκευή ή καρτέλα. Άνοιξέ την ξανά για να δεις την πιο πρόσφατη έκδοση.");
        }
        const base = current?.dirty ? current.base : current?.version ?? null;
        const record = { key, value, version: nextVersion(current?.version, writer), dirty: 1 };
        if (base !== undefined) record.base = base;
        entries.put(record);
        return record;
      }).catch(error => {
        if (error.name === "QuotaExceededError") throw new Error("Η αποθήκευση απέτυχε. Έλεγξε τον χώρο της συσκευής.");
        throw error;
      });
      // The transaction has committed locally. A network response is not
      // required to return success to the editor.
      try { notify(); } catch {}
      onStatus(navigator.onLine ? "sending" : "pending");
      kick();
      return saved;
    },
    start(change, status, conflict = () => {}) {
      onChange = change;
      onStatus = status;
      onConflict = conflict;
      async function otherTab() {
        await onChange();
        kick();
      }
      if (channel) channel.onmessage = otherTab;
      else window.addEventListener("storage", event => {
        if (event.key === accountChannel) otherTab();
      });
      window.addEventListener("storage", event => { if (event.key===sessionKey && storedSession()!==token && (!storedSession() || accountName(storedSession())!==account)) location.reload(); });
      window.addEventListener("focus", kick);
      window.addEventListener("online", kick);
      window.addEventListener("offline", kick);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) otherTab();
      });
      window.setInterval(() => { if (navigator.onLine && !document.hidden && !running && !timer) kick(); }, 10000);
      kick();
    }
  };
}
