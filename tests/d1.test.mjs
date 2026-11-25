import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.mjs";
import { presets } from "../dist/model.mjs";
import { mergePlanners } from "../dist/pairing.mjs";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  function prepare(sql, params = []) {
    const statement = () => sqlite.prepare(sql);
    return {
      bind: (...args) => prepare(sql, args),
      run: async () => statement().run(...params),
      all: () => ({ results: statement().all(...params) }),
      first: async column => statement().get(...params)?.[column] ?? null
    };
  }
  return {
    DB: {
      prepare,
      batch(queries) {
        sqlite.exec("BEGIN");
        try {
          const result = queries.map(query => query.all());
          sqlite.exec("COMMIT");
          return result;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      }
    }
  };
}

test("a deleted notebook stays deleted across retries, dated notes survive and each browser has its own data", async () => {
  const env = database();
  const key = () => randomBytes(32).toString("hex");
  const owner = key(), visitor = key();
  const rev = n => String(n).padStart(16, "0") + "-00000000-0000-4000-8000-000000000000";
  const request = (token, data, path = "/api/planner") => worker.fetch(new Request("https://planner.test" + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    method: data ? "PUT" : "GET", body: data ? JSON.stringify(data) : undefined
  }), env);
  const put = async (token, key, value, version) => {
    const res = await request(token, { key, value, version });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.equal((await request(null)).status, 401);
  const book = presets[0], bookKey = "book:" + book.id;
  await put(owner, bookKey, book, rev(1));
  const note = { id: "a", bookId: book.id, title: "Ψώνια", kind: "list", text: "",
    items: [{ label: "Γάλα", done: true }], date: "2028-02-29", updated: 1 };
  await put(owner, "note:a", note, rev(2));
  await put(owner, bookKey, null, rev(3));
  assert.equal((await put(owner, bookKey, book, rev(1))).value, null);
  assert.deepEqual((await (await request(visitor)).json()).records, []);
  await put(visitor, bookKey, book, rev(4));
  const stored = (await (await request(owner)).json()).records;
  assert.equal(stored.find(row => row.key === bookKey).value, null);
  assert.deepEqual(stored.find(row => row.key === "note:a").value, note);

  for (let i = 0; i < 13; i++) {
    await put(owner, "note:n" + i, { ...note, id: "n" + i, bookId: "" }, rev(5));
  }
  const first = await (await request(owner)).json();
  const second = await (await request(owner, null, "/api/planner?after=" + first.next)).json();
  assert.equal(new Set([...first.records, ...second.records].map(row => row.key)).size, 15);
  assert.equal(second.next, null);
  assert.equal((await request(owner, { key: "note:a", value: { ...note, date: "2026-02-30" }, version: rev(7) })).status, 400);
});

test("a one-time, expiring code gives a second device access to the original Planner, including future writes", async () => {
  const env = database();
  const token = () => randomBytes(32).toString("hex");
  const owner = token(), oldDevice = token(), pairedDevice = token(), outsider = token();
  const call = (key, path, method = "GET", data) => worker.fetch(new Request("https://planner.test/api/" + path, {
    method, headers: { Authorization: "Bearer " + key }, body: data ? JSON.stringify(data) : undefined
  }), env);
  const version = "0000000000000001-00000000-0000-4000-8000-000000000000";
  const entry = { key: "book:village", version, value: presets[1] };
  assert.equal((await call(owner, "planner", "PUT", entry)).status, 200);
  const { code, expires } = await (await call(owner, "pairing", "POST")).json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
  assert.ok(expires > Date.now() && expires <= Date.now() + 600000);
  assert.deepEqual((await (await call(oldDevice, "planner")).json()).records, []);
  const join = (device, newToken, value = code) => call(device, "pairing/redeem", "POST", { code: value, newToken });
  assert.deepEqual(await (await join(oldDevice, pairedDevice)).json(), { samePlanner: false });
  assert.equal((await join(oldDevice, pairedDevice)).status, 200);
  assert.equal((await join(outsider, token())).status, 409);
  assert.deepEqual((await (await call(pairedDevice, "planner")).json()).records, [entry]);
  const second = { ...entry, key: "book:ideas", value: presets[3] };
  assert.equal((await call(pairedDevice, "planner", "PUT", second)).status, 200);
  assert.deepEqual((await (await call(owner, "planner")).json()).records, [second, entry]);
  assert.deepEqual((await (await call(outsider, "planner")).json()).records, []);
  const newer = "0000000000000002-00000000-0000-4000-8000-000000000000";
  const latest = "0000000000000003-00000000-0000-4000-8000-000000000000";
  await call(owner, "planner", "PUT", { ...second, base: second.version, version: newer, value: null });
  const stale = await call(pairedDevice, "planner", "PUT", { ...second, base: second.version, version: latest });
  assert.deepEqual(await stale.json(), { key: second.key, value: null, version: newer });
  const again = await (await call(pairedDevice, "pairing", "POST")).json();
  assert.deepEqual(await (await join(owner, token(), again.code)).json(), { samePlanner: true });
  const expired = await (await call(owner, "pairing", "POST")).json();
  await env.DB.prepare("UPDATE planner_pairings SET expires_at = 0").run();
  assert.equal((await join(oldDevice, token(), expired.code)).status, 409);
});

test("joining keeps conflicting local notebooks and notes under new IDs, with dates, checks and links intact", () => {
  const book = { id: "custom", name: "Εκδρομές", color: "rose", created: 1 };
  const note = { id: "local", title: "Βουνό", kind: "list", items: [{ label: "Νερό", done: true }],
    text: "", date: "2027-01-01", bookId: book.id, updated: 3 };
  const local = [{ key: "book:custom", value: book }, { key: "note:local", value: note },
    { key: "book:shopping", value: presets[0] }];
  const remote = [{ key: "book:custom", value: { ...book, name: "Χρώματα" } },
    { key: "note:local", value: null }, { key: "book:shopping", value: null }];
  const merged = Array.from(mergePlanners(local, remote, () => "version"));
  assert.equal(merged.length, 5);
  const copiedBook = merged.find(row => row.value?.name === book.name);
  const copiedNote = merged.find(row => row.value?.title === note.title);
  assert.deepEqual(copiedNote.value, { ...note, id: copiedNote.value.id, bookId: copiedBook.value.id });
  assert.notEqual(copiedNote.value.id, note.id);
  assert.notEqual(copiedBook.value.id, book.id);
  assert.equal(merged.find(row => row.key === "book:shopping").value, null);
});
