import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const js = ts.transpileModule(fs.readFileSync(new URL("../app/scan-cache.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { loadScanCache, saveScanCache } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const key = "financial-titan-baidu-last-scan";

function environment({ legacy, fail = false } = {}) {
  const local = new Map([["financial-titan-projects", "preserve-project"], ["financial-titan-deepseek-key", "preserve-key"]]);
  if (legacy) local.set(key, JSON.stringify(legacy));
  let stored;
  const database = {
    close() {},
    transaction(_, mode) {
      let pending;
      const request = {};
      const transaction = {
        objectStore: () => ({ put(value) { pending = value; }, get() { request.result = stored; return request; } }),
      };
      setTimeout(() => {
        if (fail) { transaction.error = new Error("QuotaExceededError"); transaction.onabort(); }
        else { if (mode === "readwrite") stored = pending; transaction.oncomplete(); }
      }, 0);
      return transaction;
    },
  };
  globalThis.window = {
    localStorage: { getItem: k => local.get(k) ?? null, setItem() { throw new Error("localStorage full"); }, removeItem: k => local.delete(k) },
    indexedDB: { open() { const request = { result: database }; setTimeout(() => request.onsuccess(), 0); return request; } },
  };
  return local;
}

test("large evidence persists without writing localStorage; reload restores full payload", async () => {
  const local = environment();
  const scan = { evidence: [{ snippet: "完整证据".repeat(100000) }], topics: [1] };
  await saveScanCache(scan);
  assert.deepEqual(await loadScanCache(), scan);
  assert.equal(local.get("financial-titan-projects"), "preserve-project");
  assert.equal(local.get("financial-titan-deepseek-key"), "preserve-key");
});

test("legacy scan is removed only after migration commits", async () => {
  const scan = { evidence: ["original"] };
  const local = environment({ legacy: scan });
  assert.deepEqual(await loadScanCache(), scan);
  assert.equal(local.has(key), false);
  assert.deepEqual(await loadScanCache(), scan);
});

test("migration failure preserves old scan and assets", async () => {
  const scan = { evidence: ["keep"] };
  const local = environment({ legacy: scan, fail: true });
  assert.deepEqual(await loadScanCache(), scan);
  assert.equal(local.get(key), JSON.stringify(scan));
  await assert.rejects(saveScanCache({ topics: [] }), /QuotaExceeded/);
  assert.equal(local.get("financial-titan-projects"), "preserve-project");
});
