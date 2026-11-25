import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.mjs";
import { presets } from "../dist/model.mjs";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  function prepare(sql, params = []) {
    const statement = () => sqlite.prepare(sql);
    return {
      bind: (...args) => prepare(sql, args),
      run: async () => statement().run(...params),
      all: () => ({ results: statement().all(...params) })
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
