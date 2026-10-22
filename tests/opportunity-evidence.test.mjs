import test from 'node:test';
import assert from 'node:assert/strict';
import { opportunityCohort, opportunityEvidencePage, prepareRecommendation, recommendationReferences } from '../server/opportunity-evidence.mjs';

const now = new Date('2026-10-22T12:00:00Z');
const records = Array.from({ length: 12 }, (_, i) => ({ id: `hn:${i}`, source: 'hn', author: `person${i % 10}`, authorId: `hn:person${i % 10}`, title: 'Looking for a tool to search local PDFs', text: `I need a tool that can search my local PDF files offline. My current process starts with folder ${i}.`, date: '2026-10-20T12:00:00Z', url: `https://news.ycombinator.com/item?id=${i + 1}`, status: 'public' }));
const candidate = { problemId: 'signal:pdf', sourceIds: records.map(r => r.id), status: 'ready', classification: 'product-opportunity' };

test('business evidence pages contain one real original request per current public account', () => {
  const all = [...records, { ...records[0], id: 'hn:old', authorId: 'hn:old', date: '2020-01-01', url: 'https://news.ycombinator.com/item?id=99' }];
  const c = { ...candidate, sourceIds: all.map(r => r.id) };
  assert.equal(opportunityCohort(c, all, { now }).length, 10);
  assert.equal(opportunityCohort(c, all, { now, historical: true }).length, 11);
  const page = opportunityEvidencePage(c, all, '', { now });
  assert.equal(page.totalAccounts, 10); assert.equal(page.evidence.length, 10);
  assert.ok(page.evidence.every(row => row.quote && row.url));
  assert.throws(() => opportunityEvidencePage(c, all, 'bad', { now }), /cursor/);
});

test('recommendations require reading a cohort and never invent customers or select an idea', () => {
  const cohort = opportunityCohort(candidate, records, { now });
  const input = { title: 'Offline document search', description: 'Search local document collections without uploading their contents.' };
  assert.throws(() => prepareRecommendation(candidate, records, input, new Set(cohort.slice(0, 3).map(r => r.id)), { now }), /10 distinct/);
  const result = prepareRecommendation(candidate, records, input, new Set(cohort.map(r => r.id)), { now });
  assert.equal(result.requesterCount, 10); assert.equal(result.sourceIds.length, 10); assert.equal(result.title, input.title);
});

test('only a final citation to the recommended cohort activates the full demand evidence view', () => {
  const recommendation = { sourceIds: ['hn:1', 'hn:2', 'hn:3'] };
  assert.deepEqual(recommendationReferences(recommendation, ['other']), ['other']);
  assert.deepEqual(recommendationReferences(recommendation, ['hn:1']), recommendation.sourceIds);
  assert.deepEqual(recommendationReferences(null, ['hn:1']), ['hn:1']);
});
