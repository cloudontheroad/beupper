import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../app/strategy-learning.ts", import.meta.url), "utf8")
  .replace('import { apiUrl, readJsonResponse } from "./api-client";', 'const apiUrl = x => x; const readJsonResponse = response => response.json();');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { learnLatestDouyinSnapshot } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("learning includes unmatched works, deduplicates and persists audit-warning success", async () => {
  const store = new Map();
  const write = (key, value) => store.set(`financial-titan-${key}`, JSON.stringify(value));
  globalThis.window = { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }, dispatchEvent() {} };
  store.set("financial-titan-deepseek-key", "test-only-key");
  write("douyin-live-reviews", [{ platformId: "new", title: "未匹配新稿", views: 100 }, { platformId: "new", title: "未匹配新稿", views: 200 }]);
  write("projects", [{ id: "unrelated", script: "不能泄漏到无关作品" }]);
  write("douyin-sync-snapshots", [{ collectedAt: "2026-10-28T10:00:00Z" }]);
  let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].projectMatched, false);
    assert.equal(body.records[0].scriptOpening, "");
    assert.equal(body.records[0].performance.views, 200);
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ ok: true, iteration: { id: "iteration-1" }, promotionWarning: "audit unavailable" }) };
  };
  await Promise.all([learnLatestDouyinSnapshot(), learnLatestDouyinSnapshot()]);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(store.get("financial-titan-learning-status")).state, "succeeded");
  assert.equal(JSON.parse(store.get("financial-titan-learning-status")).warning, "audit unavailable");
  assert.equal(JSON.parse(store.get("financial-titan-strategy-profile")).id, "iteration-1");

  globalThis.fetch = async () => { throw new Error("network failure"); };
  await assert.rejects(learnLatestDouyinSnapshot(), /network failure/);
  assert.equal(JSON.parse(store.get("financial-titan-learning-status")).state, "failed");
  assert.equal(JSON.parse(store.get("financial-titan-strategy-profile")).id, "iteration-1", "failed learning preserves active strategy");
});
