import { presets } from "./model.mjs";

const defaults = new Set(presets.map(book => book.id));

// The invited Planner supplies the notebooks and their deletion state. Import this device's
// live custom notebooks and notes without overwriting an existing or previously deleted record.
export function mergePlanners(local, remote, makeVersion) {
  const merged = new Map(remote.map(row => [row.key, { ...row, dirty: 0 }]));
  const bookIds = new Map();
  function add(type, entry, value) {
    let id = value.id, key = type + ":" + id;
    const existing = merged.get(key);
    if (existing && JSON.stringify(existing.value) === JSON.stringify(value)) return id;
    if (existing) {
      id = crypto.randomUUID();
      key = type + ":" + id;
      value = { ...value, id };
    }
    merged.set(key, { key, version: makeVersion(entry.version), value, dirty: 1, base: null });
    return id;
  }
  for (const entry of local) {
    if (!entry.value || !entry.key.startsWith("book:")) continue;
    const { id } = entry.value;
    bookIds.set(id, defaults.has(id) ? id : add("book", entry, entry.value));
  }
  for (const entry of local) {
    if (!entry.value || !entry.key.startsWith("note:")) continue;
    const bookId = bookIds.get(entry.value.bookId) || "";
    const activeBook = merged.get("book:" + bookId)?.value;
    add("note", entry, { ...entry.value, bookId: activeBook ? bookId : "" });
  }
  return merged.values();
}
