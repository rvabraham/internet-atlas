import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceHealth } from '../server/health.mjs';
const now = new Date('2026-10-22T22:00:00Z');
const record = { id: 'hn:1', source: 'hn', title: 'Software request', text: 'I need an app that searches my PDF documents locally.', author: 'alex', authorId: 'hn:alex', date: '2026-10-21T12:00:00Z', fetchedAt: now.toISOString(), status: 'public', url: 'https://news.ycombinator.com/item?id=1' };

test('health separates cached coverage, failed live collection and absent connections', () => {
  const health = sourceHealth({ records: [record], feeds: [{ source: 'hn', status: 'error', error: 'HTTP429', fetchedAt: now.toISOString() }], signals: [] }, now);
  const hn = health.sources.find(source => source.source === 'hn');
  assert.equal(hn.status, 'partial'); assert.equal(hn.recordCount, 1); assert.equal(hn.requestCount, 1);
  assert.equal(hn.feedsOk, 0); assert.equal(hn.feedsFailed, 1);
  assert.equal(health.sources.find(source => source.source === 'x').status, 'not-connected');
  assert.equal(health.sources.find(source => source.source === 'reddit').status, 'unavailable');
});

test('successful empty results are healthy and a later success supersedes an old failure', () => {
  const feeds = [{ source: 'reddit', status: 'error', error: 'HTTP429', fetchedAt: '2026-10-20T12:00:00Z' }, { source: 'reddit', status: 'ok', count: 0, fetchedAt: now.toISOString() }];
  const source = sourceHealth({ records: [], feeds }, now).sources.find(source => source.source === 'reddit');
  assert.equal(source.status, 'ok'); assert.equal(source.recordCount, 0); assert.equal(source.feedsFailed, 0);
});

test('dataset health retains retrieval dates, original dates and attribution independently', () => {
  const dataset = { name: 'Attributed archive', url: 'https://example.com/archive', license: 'Source terms apply' };
  const health = sourceHealth({ records: [{ ...record, origin: 'dataset', date: '2020-01-01T12:00:00Z', dataset }], signals: [{ requesterCount: 10 }], analysis: { status: 'partial', pendingCount: 3 } }, now);
  const source = health.sources.find(source => source.source === 'hn');
  assert.equal(source.status, 'ok'); assert.equal(source.recentRequestCount, 0);
  assert.equal(source.lastFetchedAt, now.toISOString()); assert.equal(source.newestPostAt, '2020-01-01T12:00:00Z');
  assert.equal(health.datasets[0].recordCount, 1); assert.equal(health.analysis.verifiedCurrentGroups10plus, 0);
  assert.equal(health.analysis.pendingCount, 3);
});

test('only groups with a successful membership audit are reported as verified ten-plus demand', () => {
  const health = sourceHealth({ records: [record], signals: [
    { requesterCount: 20 },
    { requesterCount: 20, audit: { status: 'failed' } },
    { requesterCount: 9, audit: { status: 'verified' } },
    { requesterCount: 10, audit: { status: 'verified' } },
  ] }, now);
  assert.equal(health.analysis.verifiedCurrentGroups10plus, 1);
  const partiallyRetained = sourceHealth({ records: [record], signals: [{ requesterCount: 10, audit: { status: 'partial' } }] }, now);
  assert.equal(partiallyRetained.analysis.verifiedCurrentGroups10plus, 1);
});
