import { presets, validRecord, validVersion } from "./model.mjs";
import { mergePlanners } from "./pairing.mjs";

const seedVersion = "0000000000000000-00000000-0000-4000-8000-000000000000";
const channelName = "planner.v2.changes";
const endpoint = location.hostname === "andrew-imerisio-planner.flutedcloth5.chatgpt.site"
  ? "https://planner.asmylonas8.workers.dev/api/" : "/api/";

function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

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
  let { token, writer } = await transact(db, ["settings", "entries"], "readwrite", async tx => {
    const settings = tx.objectStore("settings");
    const entries = tx.objectStore("entries");
    let token = await result(settings.get("token"));
    let writer = await result(settings.get("writer"));
    if (!writer) { writer = crypto.randomUUID(); settings.put(writer, "writer"); }
    if (!token) {
      token = newToken();
      settings.put(token, "token");
      for (const value of presets) entries.put({ key: "book:" + value.id, version: seedVersion, value, dirty: 1 });
    }
    for (const { key, value } of legacy) {
      if (!await result(entries.getKey(key))) entries.put({ key, version: nextVersion(), value, dirty: 1 });
    }
    return { token, writer };
  });
  // Only remove the legacy copy after the records and their pending uploads committed together.
  for (const { source, raw } of legacy) {
    try { if (localStorage.getItem(source) === raw) localStorage.removeItem(source); } catch { /* Retry next launch. */ }
  }

  const read = fn => transact(db, "entries", "readonly", tx => result(fn(tx.objectStore("entries"))));
  const settingsValue = key => transact(db, "settings", "readonly", tx => result(tx.objectStore("settings").get(key)));
  let paired = !!await settingsValue("paired");
  const scoped = (mode, fn, session) => transact(db, ["settings", "entries"], mode, async tx => {
    const settings = tx.objectStore("settings");
    if (await result(settings.get("token")) !== session) throw new Error("Το Planner άλλαξε σε άλλη καρτέλα. Άνοιξέ το ξανά.");
    return fn(tx.objectStore("entries"), settings);
  });
  const edit = (fn, session = token) => scoped("readwrite", fn, session);
  const dirty = () => read(entries => entries.index("dirty").count(1));
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;
  let onChange = () => {}, onStatus = () => {}, onConflict = () => {};
  let running = null, scheduled = false, timer, backoff = 2000;

  function notify() {
    if (channel) channel.postMessage("changed");
    else try { localStorage.setItem(channelName, crypto.randomUUID()); } catch { /* Refreshes on foreground. */ }
  }

  async function api(path, options, session) {
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), 15000);
    try {
      const response = await fetch(endpoint + path, {
        ...options, signal: control.signal, cache: "no-store", credentials: "omit",
        headers: { Authorization: "Bearer " + session, ...(options.body && { "Content-Type": "application/json" }) }
      });
      if (!response.ok) {
        if (path === "pairing/redeem" && [400, 409].includes(response.status)) throw new Error("Ο κωδικός είναι λάθος, έχει λήξει ή έχει ήδη χρησιμοποιηθεί.");
        throw new Error("Η βάση δεν απάντησε. Δοκίμασε ξανά όταν έχεις σύνδεση.");
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function pages(session, receive) {
    let cursor = "";
    do {
      const page = await api("planner" + (cursor ? "?after=" + encodeURIComponent(cursor) : ""), {}, session);
      if (!Array.isArray(page.records) || (page.next && page.next <= cursor)) throw new Error("page");
      if (page.records.some(row => !row || !validVersion(row.version) || !validRecord(row.key, row.value))) throw new Error("record");
      await receive(page.records);
      cursor = page.next;
    } while (cursor);
  }

  async function applyRemote(records, session, sent) {
    let conflictMessage = "";
    const changed = await edit(async entries => {
      let changed = false;
      for (const row of records) {
        if (!row || !validVersion(row.version) || !validRecord(row.key, row.value)) throw new Error("record");
        const current = await result(entries.get(row.key));
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
          } else if (!current.value && row.value) {
            conflictMessage = "Η καταχώρηση άλλαξε σε άλλη συσκευή πριν διαγραφεί. Μπορείς να την ελέγξεις ξανά.";
          }
        } else if (current && row.version < current.version) continue;
        if (current && row.version === current.version && !current.dirty) continue;
        if (current?.version !== row.version) changed = true;
        entries.put({ key: row.key, version: row.version, value: row.value, dirty: 0 });
      }
      return changed;
    }, session);
    if (conflictMessage) onConflict(conflictMessage);
    return changed;
  }

  async function transfer(session) {
    let wrote = false;
    try {
      if (!navigator.onLine) throw new Error("offline");
      for (;;) {
        const pending = await scoped("readonly", entries => result(entries.index("dirty").getAll(1, 8)), session);
        if (!pending.length) break;
        onStatus("sending");
        for (const { key, value, version, base } of pending) {
          if (session !== token) return false;
          const row = await api("planner", { method: "PUT", body: JSON.stringify({ key, value, version, base }) }, session);
          if (row.key !== key || (base === undefined && row.version < version)) throw new Error("acknowledgement");
          if (await applyRemote([row], session, { version })) { notify(); await onChange(); }
          wrote = true;
        }
      }
      await pages(session, async records => {
        if (await applyRemote(records, session)) { notify(); await onChange(); }
      });
      const remaining = await dirty();
      scheduled ||= remaining > 0;
      onStatus(remaining ? "sending" : wrote ? "saved" : "ready");
      backoff = 2000;
      return true;
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
    clearTimeout(timer);
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
    async invite() {
      if (!await sync()) throw new Error("Σύνδεσε τη συσκευή στο διαδίκτυο για να δημιουργήσεις κωδικό.");
      const invitation = await api("pairing", { method: "POST" }, token);
      await edit((entries, settings) => settings.put(true, "paired"));
      paired = true;
      notify();
      return invitation;
    },
    async join(input) {
      const code = input.toUpperCase().replace(/[\s-]/g, "");
      if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) throw new Error("Γράψε τα 12 γράμματα και ψηφία του κωδικού.");
      const previous = token;
      if (!await sync()) throw new Error("Σύνδεσε τη συσκευή στο διαδίκτυο και δοκίμασε ξανά.");
      const next = await edit(async (entries, settings) => {
        let pending = await result(settings.get("pairing"));
        if (pending?.code !== code) {
          pending = { code, token: newToken() };
          settings.put(pending, "pairing");
        }
        return pending.token;
      }, previous);
      const receipt = await api("pairing/redeem", { method: "POST", body: JSON.stringify({ code, newToken: next }) }, previous);
      if (typeof receipt.samePlanner !== "boolean") throw new Error("Η σύνδεση δεν επιβεβαιώθηκε. Δοκίμασε ξανά.");
      const incoming = [];
      if (!receipt.samePlanner) await pages(next, records => incoming.push(...records));
      // Swap the namespace, its cache and any uploads in one durable transaction.
      await edit(async (entries, settings) => {
        if (!receipt.samePlanner) {
          const merged = mergePlanners(await result(entries.getAll()), incoming, previous => nextVersion(previous, writer));
          entries.clear();
          for (const row of merged) entries.put(row);
          settings.put(next, "token");
        }
        settings.put(true, "paired");
        settings.delete("pairing");
      }, previous);
      if (!receipt.samePlanner) token = next;
      paired = true;
      notify();
      await onChange();
      kick();
      return receipt.samePlanner;
    },
    async save(type, id, value, expected) {
      const key = type + ":" + id;
      if (!validRecord(key, value)) throw new Error("Έλεγξε τα στοιχεία της καταχώρησης.");
      await edit(async entries => {
        const current = await result(entries.get(key));
        if ((current?.version ?? null) !== expected) {
          throw new Error("Η καταχώρηση άλλαξε σε άλλη συσκευή ή καρτέλα. Άνοιξέ την ξανά για να δεις την πιο πρόσφατη έκδοση.");
        }
        const base = current?.dirty ? current.base : current?.version ?? null;
        const record = { key, value, version: nextVersion(current?.version, writer), dirty: 1 };
        if (base !== undefined) record.base = base;
        entries.put(record);
      }).catch(error => {
        if (error.name === "QuotaExceededError") throw new Error("Η αποθήκευση απέτυχε. Έλεγξε τον χώρο της συσκευής.");
        throw error;
      });
      notify();
      onStatus(navigator.onLine ? "sending" : "pending");
      kick();
    },
    start(change, status, conflict = () => {}) {
      onChange = change;
      onStatus = status;
      onConflict = conflict;
      async function otherTab() {
        if (await settingsValue("token") !== token) { location.reload(); return; }
        paired = !!await settingsValue("paired");
        await onChange();
        kick();
      }
      if (channel) channel.onmessage = otherTab;
      else window.addEventListener("storage", event => {
        if (event.key === channelName) otherTab();
      });
      window.addEventListener("online", kick);
      window.addEventListener("offline", kick);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) otherTab();
      });
      window.setInterval(() => { if (paired && navigator.onLine && !document.hidden && !running) kick(); }, 12000);
      kick();
    }
  };
}
