import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-class-modules-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const db = await import("./db.js");
const sorting = await import("./sorting.js");
const posts = await import("./class-posts.js");
const modules = await import("./class-modules.js");

before(async () => {
  await db.initSchema();
  const now = new Date().toISOString();
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["module-class", "Module Class", "MOD1", now]);
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["module-other", "Other Class", "MOD2", now]);
});

test("published assignments get stable chronological module numbers", async () => {
  const sort = await sorting.createActivity({
    title: "Sector foundations", prompt: "Sort them.", status: "published",
    buckets: ["Consumer Discretionary", "Information Technology"], tokens: [{ ticker: "NKE" }, { ticker: "AAPL" }],
  });
  await db.run(`UPDATE sort_activities SET created_at = ? WHERE id = ?`, ["2026-09-01T00:00:00.000Z", sort.id]);
  const mission = await posts.createClassPost({ kind: "portfolio_mission", title: "Balanced portfolio", body: "Research and explain." });
  await posts.setClassPostStatus(mission.id, "published");
  await db.run(`UPDATE class_posts SET created_at = ? WHERE id = ?`, ["2026-09-02T00:00:00.000Z", mission.id]);
  const catalog = await modules.classModuleCatalog("module-class");
  assert.deepEqual(catalog.map((item) => [item.key, item.moduleNumber]), [
    [`sort:${sort.id}`, 1], [`post:${mission.id}`, 2],
  ]);
});

test("hidden modules are class-specific and replacement rejects junk keys", async () => {
  const catalog = await modules.classModuleCatalog("module-class");
  const moduleTwo = catalog[1]!.key;
  const saved = await modules.replaceHiddenClassModules("module-class", [moduleTwo, moduleTwo, "post:not-real"]);
  assert.deepEqual(saved, [moduleTwo]);
  assert.deepEqual([...(await modules.hiddenClassModuleKeys("module-class"))], [moduleTwo]);
  assert.equal((await modules.hiddenClassModuleKeys("module-other")).size, 0);
  await modules.replaceHiddenClassModules("module-class", []);
  assert.equal((await modules.hiddenClassModuleKeys("module-class")).size, 0);
});
