import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = fs.readFileSync(new URL("../app/social-search-queries.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { socialSearchQueries } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
test("search prefers dynamic entities and deduplicates", () => {
  assert.deepEqual(socialSearchQueries("冗长提问", { actors: ["公司甲", "公司甲", "公司乙"] }), ["公司甲", "公司乙"]);
});
test("legacy topics drop rhetorical tail and event suffix", () => {
  assert.deepEqual(socialSearchQueries("某某公司财报超预期：为什么股价反跌？"), ["某某公司"]);
});
