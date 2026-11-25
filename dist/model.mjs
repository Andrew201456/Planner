export const colors = {
  butter: "Κίτρινο", sage: "Πράσινο", lilac: "Λιλά",
  apricot: "Βερίκοκο", sky: "Γαλάζιο", rose: "Ροζ"
};

export const presets = [
  { id: "shopping", name: "Ψώνια", color: "butter", icon: "shopping", created: 0 },
  { id: "village", name: "Χωριό", color: "sage", icon: "village", created: 0 },
  { id: "personal", name: "Προσωπικά", color: "lilac", icon: "personal", created: 0 },
  { id: "ideas", name: "Ιδέες", color: "apricot", icon: "ideas", created: 0 }
];

export const validKey = key => typeof key === "string" && /^(book|note|food):[A-Za-z0-9-]{1,70}$/.test(key);
export const validVersion = version => typeof version === "string" &&
  /^\d{16}-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(version);

export function validRecord(key, value) {
  if (!validKey(key)) return false;
  if (value === null) return true;
  const [type, id] = key.split(":");
  if (!value || value.id !== id) return false;
  if (type === "book") return typeof value.name === "string" && value.name.trim().length > 0 &&
    value.name.length <= 45 && Object.hasOwn(colors, value.color) && Number.isSafeInteger(value.created);
  if (type === "food") return typeof value.name === "string" && value.name.trim().length > 0 &&
    value.name.length <= 300 && typeof value.date === "string" &&
    /^\d{4}-\d\d-\d\d$/.test(value.date) && !value.date.startsWith("0000") &&
    Number.isFinite(Date.parse(value.date)) && new Date(value.date).toISOString().slice(0,10) === value.date &&
    (value.calories === null || Number.isSafeInteger(value.calories) && value.calories >= 0 && value.calories <= 100000) &&
    Number.isSafeInteger(value.created) && Number.isSafeInteger(value.updated);
  const { title, text, kind, items, date, bookId, updated } = value;
  if (typeof title !== "string" || title.length > 160 || typeof text !== "string" || text.length > 20000 ||
      !["text", "list"].includes(kind) || !Array.isArray(items) || items.length > 10000 ||
      typeof bookId !== "string" || (bookId !== "" && !validKey("book:" + bookId)) ||
      !Number.isSafeInteger(updated) || typeof date !== "string") return false;
  if (date && (!/^\d{4}-\d\d-\d\d$/.test(date) || date.startsWith("0000") ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return false;
  let listLength = Math.max(0, items.length - 1);
  for (const item of items) {
    if (!item || typeof item.label !== "string" || typeof item.done !== "boolean") return false;
    listLength += item.label.length;
  }
  return listLength <= 20000;
}
