import { presets, validRecord, validVersion } from "./model.mjs";

const seedVersion = "0000000000000000-00000000-0000-4000-8000-000000000000";
const channelName = "planner.v2.changes";
const endpoint = location.hostname === "andrew-imerisio-planner.flutedcloth5.chatgpt.site"
  ? "https://planner.asmylonas8.workers.dev/api/planner" : "/api/planner";

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(db, names, mode, work) {
  const tx = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Η αλλαγή δεν αποθηκεύτηκε στη συσκευή."));
  });
  try {
    const value = await work(tx);
    await done;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* Already closed. */ }
    await done.catch(() => {});
    throw error;
  }
}

function nextVersion(previous = seedVersion) {
  const time = Math.max(Date.now(), Number(previous.slice(0, 16)) + 1);
  return String(time).padStart(16, "0") + "-" + crypto.randomUUID();
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

export async function openPlanner() {
  const opening = indexedDB.open("planner.v2", 1);
  opening.onupgradeneeded = () => {
    const entries = opening.result.createObjectStore("entries", { keyPath: "key" });
    entries.createIndex("dirty", "dirty");
    opening.result.createObjectStore("settings");
  };
  const db = await result(opening);
  db.onversionchange = () => db.close();
  const legacy = legacyEntries();
  const token = await transact(db, ["settings", "entries"], "readwrite", async tx => {
    const settings = tx.objectStore("settings");
    const entries = tx.objectStore("entries");
    let token = await result(settings.get("token"));
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      settings.put(token, "token");
      for (const value of presets) entries.put({ key: "book:" + value.id, version: seedVersion, value, dirty: 1 });
    }
    for (const { key, value } of legacy) {
      if (!await result(entries.getKey(key))) entries.put({ key, version: nextVersion(), value, dirty: 1 });
    }
    return token;
  });
  // Only remove the legacy copy after the records and their pending uploads committed together.
  for (const { source, raw } of legacy) {
    try { if (localStorage.getItem(source) === raw) localStorage.removeItem(source); } catch { /* Retry next launch. */ }
  }

  const read = fn => transact(db, "entries", "readonly", tx => result(fn(tx.objectStore("entries"))));
  const edit = fn => transact(db, "entries", "readwrite", tx => fn(tx.objectStore("entries")));
  const dirty = () => read(entries => entries.index("dirty").count(1));
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;
  let onChange = () => {}, onStatus = () => {};
  let running = false, scheduled = false, timer, backoff = 2000;

  function notify() {
    if (channel) channel.postMessage("changed");
    else try { localStorage.setItem(channelName, crypto.randomUUID()); } catch { /* Refreshes on foreground. */ }
  }

  async function api(options = {}, after = "") {
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), 15000);
    try {
      const response = await fetch(endpoint + (after ? "?after=" + encodeURIComponent(after) : ""), {
        ...options, signal: control.signal, cache: "no-store", credentials: "omit",
        headers: { Authorization: "Bearer " + token, ...(options.body && { "Content-Type": "application/json" }) }
      });
      if (!response.ok) throw new Error("Cloudflare " + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function applyRemote(records) {
    return edit(async entries => {
      let changed = false;
      for (const row of records) {
        if (!row || !validVersion(row.version) || !validRecord(row.key, row.value)) throw new Error("record");
        const current = await result(entries.get(row.key));
        if (current && row.version < current.version) continue;
        if (current && row.version === current.version && !current.dirty) continue;
        if (current?.version !== row.version) changed = true;
        entries.put({ key: row.key, version: row.version, value: row.value, dirty: 0 });
      }
      return changed;
    });
  }

  async function sync() {
    if (running) { scheduled = true; return; }
    clearTimeout(timer);
    running = true;
    scheduled = false;
    let wrote = false;
    try {
      if (!navigator.onLine) throw new Error("offline");
      for (;;) {
        const pending = await read(entries => entries.index("dirty").getAll(1, 8));
        if (!pending.length) break;
        onStatus("sending");
        for (const { key, value, version } of pending) {
          const row = await api({ method: "PUT", body: JSON.stringify({ key, value, version }) });
          if (row.key !== key || row.version < version) throw new Error("acknowledgement");
          if (await applyRemote([row])) { notify(); await onChange(); }
          wrote = true;
        }
      }
      let cursor = "";
      do {
        const page = await api({}, cursor);
        if (!Array.isArray(page.records) || (page.next && page.next <= cursor)) throw new Error("page");
        if (await applyRemote(page.records)) { notify(); await onChange(); }
        cursor = page.next;
      } while (cursor);
      const remaining = await dirty();
      scheduled ||= remaining > 0;
      onStatus(remaining ? "sending" : wrote ? "saved" : "ready");
      backoff = 2000;
    } catch {
      const pending = await dirty().catch(() => 1);
      onStatus(pending ? "pending" : "unavailable");
      if (navigator.onLine) {
        timer = setTimeout(sync, backoff);
        backoff = Math.min(60000, backoff * 2);
      }
    } finally {
      running = false;
      if (scheduled) kick();
    }
  }

  function kick() {
    if (running) { scheduled = true; return; }
    clearTimeout(timer);
    timer = setTimeout(sync, 50);
  }

  return {
    all: () => read(entries => entries.getAll()),
    async save(type, id, value, expected) {
      const key = type + ":" + id;
      if (!validRecord(key, value)) throw new Error("Έλεγξε τα στοιχεία της καταχώρησης.");
      await edit(async entries => {
        const current = await result(entries.get(key));
        if ((current?.version ?? null) !== expected) {
          throw new Error("Η καταχώρηση άλλαξε σε άλλη καρτέλα. Άνοιξέ την ξανά για να δεις την πιο πρόσφατη έκδοση.");
        }
        entries.put({ key, value, version: nextVersion(current?.version), dirty: 1 });
      }).catch(error => {
        if (error.name === "QuotaExceededError") throw new Error("Η αποθήκευση απέτυχε. Έλεγξε τον χώρο της συσκευής.");
        throw error;
      });
      notify();
      onStatus(navigator.onLine ? "sending" : "pending");
      kick();
    },
    start(change, status) {
      onChange = change;
      onStatus = status;
      if (channel) channel.onmessage = () => { onChange(); kick(); };
      else window.addEventListener("storage", event => {
        if (event.key === channelName) { onChange(); kick(); }
      });
      window.addEventListener("online", kick);
      window.addEventListener("offline", kick);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) { onChange(); kick(); }
      });
      kick();
    }
  };
}
