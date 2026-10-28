import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../app/search-provider.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { searchDeepSeek, deepSeekSearchQuery } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('search uses documented endpoint and shares key without requesting duplicate full content', async () => {
  let actual;
  const result = await searchDeepSeek('Bearer test-secret', '消费上市公司 同店经营', 20, async (url, options) => {
    actual = { url, ...options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ results: [{ title: '经营公告', url: 'https://example.com/news', summary: '有日期的经营证据', snippet: '短摘要', content: '', date: '2026-10-27T01:00:00Z', site_name: '公司公告', authority: 3 }] }), { headers: { 'x-request-id': 'search-test' } });
  });
  assert.equal(actual.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(actual.headers.Authorization, 'Bearer test-secret');
  assert.equal(actual.body.need_content, false);
  assert.equal(actual.body.count, 20);
  assert.equal(result.references[0].snippet, '有日期的经营证据');
  assert.equal(result.references[0].date, '2026-10-27T01:00:00Z');
  assert.equal(result.requestId, 'search-test');
});

test('query budget preserves date operator and Unicode character limit', () => {
  const query = deepSeekSearchQuery('财😀'.repeat(200), Date.parse('2026-10-27T12:00:00Z'));
  assert.ok(Array.from(query).length <= 128);
  assert.ok(query.endsWith(' after:2026-10-24'));
});

test('unknown publication time stays unknown and empty searches remain valid', async () => {
  const result = await searchDeepSeek('test', 'query', 3, async () => new Response('{"results":[]}'));
  assert.deepEqual(result.references, []);
  const unknown = await searchDeepSeek('test', 'query', 3, async () => new Response('{"results":[{"title":"无日期","url":"https://example.com","date":null}]}'));
  assert.equal(unknown.references[0].date, '');
});

test('auth/balance errors surface without exposing credentials; malformed responses fail', async () => {
  await assert.rejects(searchDeepSeek('secret', 'query', 3, async () => new Response('{"error":{"message":"Insufficient balance"}}', { status: 402 })), /HTTP 402.*Insufficient balance/);
  await assert.rejects(searchDeepSeek('secret', 'query', 3, async () => new Response('Not Found', { status: 404 })), /非JSON/);
  await assert.rejects(searchDeepSeek('secret', 'query', 3, async () => new Response('{}')), /缺少 results/);
});
