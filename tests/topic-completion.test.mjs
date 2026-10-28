import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const src = await readFile(new URL('../app/topic-completion.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { uncoveredTopicEvents, isGenericTopicTitle } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const event = { id: 'event-1', eventId: 'raw-1', actors: ['某餐饮公司'] };
const names = (e) => e.actors;
test('one event appearing in multiple lanes is supplemented once', () => {
  assert.equal(uncoveredTopicEvents([event, event], [], [event], names).length, 1);
});
test('industry coverage does not hide a required company topic', () => {
  const industry = { title: '消费行业成本变化', observedEventIds: [], causalEventIds: ['raw-1'] };
  assert.equal(uncoveredTopicEvents([event], [industry], [event], names).length, 1);
  const company = { ...industry, title: '某餐饮公司客流下滑，折扣能补回收入吗？' };
  assert.equal(uncoveredTopicEvents([event], [industry, company], [event], names).length, 0);
});
test('a completed topic prevents another supplement; missing analysis stays pending', () => {
  const topic = { title: '某餐饮公司关店后利润增加，改善来自哪里？', causalEventIds: ['event-1'] };
  assert.equal(uncoveredTopicEvents([event], [topic], [event], names).length, 0);
  assert.equal(uncoveredTopicEvents([event], [], [event], names)[0].id, event.id);
  assert.ok(isGenericTopicTitle('公司发布新品：本股估值要重算吗？'));
  assert.ok(!isGenericTopicTitle(topic.title));
});
