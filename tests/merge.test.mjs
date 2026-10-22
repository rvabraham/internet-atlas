import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeNormalizedSnapshots, normalizedSourceKey, validateNormalizedRecord } from '../server/merge.mjs';
import { sourceHealth } from '../server/health.mjs';

const now = Date.parse('2026-10-22T23:00:00Z');
const row = (patch = {}) => ({ id: 'hn:12345', source: 'hn', title: 'Ask HN: Search local PDF files?', text: 'I need an offline tool to search all my local PDF files.', author: 'requester', authorId: 'hn:requester', url: 'https://news.ycombinator.com/item?id=12345', date: '2026-10-01T12:00:00Z', fetchedAt: '2026-10-21T12:00:00Z', status: 'public', ...patch });
const snapshot = (records = [row()], patch = {}) => ({ version: 3, records, ...patch });
const merged = (base, inputs, options = {}) => mergeNormalizedSnapshots(base, inputs, { now, ...options });
const reddit = patch => row({ id: 'reddit:t3_abc123', source: 'reddit', authorId: 'reddit:requester', url: 'https://www.reddit.com/r/software/comments/abc123/old_title/', ...patch });
const archive = (patch = {}) => row({ id: 'x:1987654321234567890', source: 'x', author: 'requester', authorId: 'x:987654321123456789', url: 'https://x.com/requester/status/1987654321234567890', origin: 'dataset', dataset: { name: 'Community Archive consent-managed public X export', url: 'https://github.com/TheExGenesis/community-archive/releases/latest', license: 'Original author rights apply.', exportId: '2026-10-22T07-09-36Z', sourceChecksum: 'a'.repeat(64), consentSnapshotAt: '2026-10-22 07:17:40.522', liveVerified: false }, collection: { provider: 'community-archive', query: 'Recent original software asks' }, ...patch });

test('normalized merge preserves stable IDs, original dates, source metadata and provenance while clearing analysis', () => {
  const initial = row({ request: { type: 'feature_request', quote: 'I need an offline tool' }, problemAnalysis: { classification: 'request' }, signalId: 'signal:old', problemIds: ['old'], score: 20, collection: { provider: 'hn', query: 'local PDF' } });
  const extra = row({ id: 'hn:import:alternate', url: `${initial.url}&utm_source=another`, fetchedAt: '2026-10-22T12:00:00Z', collection: { provider: 'hn', query: 'offline document search' } });
  const base = snapshot([initial], { signals: [{ id: 'old', requesterCount: 60 }], analysis: { status: 'ready', requestCount: 60 }, membershipAudits: [{ stale: true }], counts: { requests: 60 }, stats: { requestCount: 60 }, topics: [{ id: 'software', name: 'Software requests' }] });
  const before = structuredClone(base);
  const result = merged(base, [snapshot([extra, row({ id: 'hn:12346', url: 'https://news.ycombinator.com/item?id=12346' })])]);
  assert.equal(result.records.length, 2); assert.equal(result.merge.added, 1); assert.equal(result.merge.duplicates, 1);
  const record = result.records[0];
  assert.equal(record.id, initial.id); assert.equal(record.date, initial.date); assert.equal(record.url, initial.url); assert.deepEqual(record.alternateIds, ['hn:import:alternate']); assert.deepEqual(record.alternateUrls, [extra.url]);
  assert.deepEqual(record.collections.map(item => item.query), ['local PDF', 'offline document search']);
  assert.equal(record.request, null); assert.equal(record.problemAnalysis, null); assert.equal(record.signalId, null); assert.equal(record.problemIds, undefined); assert.equal(record.score, undefined);
  assert.deepEqual(result.signals, []); assert.deepEqual(result.membershipAudits, []); assert.deepEqual(result.analysis, { status: 'pending', method: 'pending-reanalysis' }); assert.equal(result.counts, undefined); assert.equal(result.stats, undefined);
  assert.deepEqual(base, before); assert.deepEqual(result.topics, base.topics);
  assert.deepEqual(result, merged(base, [snapshot([extra, row({ id: 'hn:12346', url: 'https://news.ycombinator.com/item?id=12346' })])]));
});

test('canonical platform identities dedupe changed slugs but keep different comments', () => {
  assert.equal(normalizedSourceKey(reddit()), normalizedSourceKey(reddit({ url: 'https://old.reddit.com/r/SOFTWARE/comments/abc123/new_title/?utm_source=x' })));
  const comments = ['c123', 'c124'].map(id => reddit({ id: `reddit:t1_${id}`, url: `https://www.reddit.com/r/software/comments/abc123/title/${id}/` }));
  const result = merged(snapshot([reddit()]), [snapshot([reddit({ id: 'reddit:import:duplicate', url: 'https://old.reddit.com/r/software/comments/abc123/new_title/' }), ...comments])]);
  assert.equal(result.records.length, 3); assert.equal(result.records[0].id, 'reddit:t3_abc123');
  const discussion = id => row({ id: `gh:comment:${id}`, source: 'github', authorId: 'github:requester', url: `https://github.com/owner/repo/discussions/12#discussioncomment-${id}` });
  assert.notEqual(normalizedSourceKey(discussion(1)), normalizedSourceKey(discussion(2)));
  const se = slug => row({ id: 'stackexchange:12', source: 'stackexchange', authorId: 'stackexchange:33', url: `https://softwarerecs.stackexchange.com/questions/12/${slug}` });
  assert.equal(normalizedSourceKey(se('one')), normalizedSourceKey(se('two')));
});

test('every feed and dataset/run receipt remains available without duplicate completed runs', () => {
  const feed = { source: 'hn', query: 'local PDF', status: 'ok', count: 1 };
  const run = { id: 'run:1', startedAt: '2026-10-21T10:00:00Z', status: 'running', attempts: [{ url: 'https://hn.algolia.com/first', status: 200 }] };
  const finished = { ...run, status: 'complete', completedAt: '2026-10-21T11:00:00Z', attempts: [...run.attempts, { url: 'https://hn.algolia.com/second', status: 429 }] };
  const collection = { startedAt: '2026-10-21T10:00:00Z', query: 'offline PDF', examined: 100, errors: [] };
  const dataset = { name: 'Public source', url: 'https://publisher.example/dataset', license: 'CC BY-NC 4.0', revision: 'original' };
  const base = snapshot([row()], { feeds: [feed], expansion: run, expansions: [run], collection, collections: [collection] });
  const incoming = snapshot([row({ origin: 'dataset', dataset })], { feeds: [feed, { source: 'reddit', status: 'error', error: '429', count: 0 }], expansions: [finished], dataset, report: { scanned: 20, accepted: 1 } });
  const result = merged(base, [incoming], { baseLabel: 'seed', inputLabels: ['dataset'] });
  assert.equal(result.feeds.length, 2); assert.equal(result.expansions.length, 1); assert.equal(result.expansion.status, 'complete'); assert.equal(result.expansion.attempts.length, 2); assert.equal(result.collections.length, 1);
  assert.equal(result.mergeReceipts[1].dataset.license, 'CC BY-NC 4.0'); assert.deepEqual(result.mergeReceipts[1].report, incoming.report);
  assert.equal(result.records[0].dataset.license, 'CC BY-NC 4.0'); assert.equal(result.records[0].dataset.revision, 'original');
});

test('expansion health reaches the source status API through normalized feeds without losing raw runs or duplicating roundtrips', () => {
  const run = { id: 'run:health', startedAt: '2026-10-22T20:00:00Z', completedAt: '2026-10-22T21:00:00Z', health: [
    { provider: 'hn', query: 'local PDF', status: 'ok', rawCount: 0, from: 1, to: 2 },
    { provider: 'reddit', query: 'search conversation history', status: 'backoff', error: 'reddit: HTTP 429; retry after 2026-10-22T22:00:00.000Z' },
    { provider: 'reddit', query: 'export chats', status: 'error', error: 'HTTP 429', retryAt: '2026-10-22T23:00:00Z' },
  ] };
  const unfinished = { id: 'run:unfinished', startedAt: '2026-10-20T19:00:00Z', health: [{ provider: 'hn', query: 'earlier query', status: 'ok', rawCount: 2 }] };
  const original = structuredClone(run);
  const result = merged(snapshot([row()], { feeds: [{ source: 'hn', query: 'old feed', status: 'ok', fetchedAt: '2026-10-01T12:00:00Z' }] }), [snapshot([], { expansion: run, expansions: [unfinished, run] })]);
  assert.equal(result.feeds.length, 5); assert.equal(result.expansions.length, 2); assert.deepEqual(result.expansions.find(item => item.id === run.id), original); assert.deepEqual(run, original);
  const backoff = result.feeds.find(feed => feed.query === 'search conversation history');
  assert.equal(backoff.source, 'reddit'); assert.equal(backoff.status, 'rate-limited'); assert.equal(backoff.collectionStatus, 'backoff'); assert.equal(backoff.error, run.health[1].error); assert.equal(backoff.retryAt, '2026-10-22T22:00:00.000Z'); assert.equal(backoff.fetchedAt, run.completedAt); assert.equal(backoff.runId, run.id);
  assert.equal(result.feeds.find(feed => feed.query === 'export chats').retryAt, '2026-10-22T23:00:00Z');
  assert.equal(result.feeds.find(feed => feed.query === 'earlier query').fetchedAt, unfinished.startedAt);
  assert.equal(result.feeds.find(feed => feed.query === 'local PDF').count, 0);
  const health = sourceHealth(result, new Date(now));
  const redditHealth = health.sources.find(source => source.source === 'reddit');
  assert.equal(redditHealth.status, 'unavailable'); assert.equal(redditHealth.feedsFailed, 2); assert.equal(redditHealth.lastAttemptAt, run.completedAt); assert.match(redditHealth.message, /HTTP 429/);
  const second = merged(result, [snapshot([], { expansion: run, expansions: [run] })]);
  assert.deepEqual(second.feeds, result.feeds); assert.deepEqual(second.expansions, result.expansions);
});

test('a cached public copy cannot reopen unavailable records, while a later explicit live verification can', () => {
  for (const status of ['closed', 'resolved', 'deleted', 'removed']) {
    const base = snapshot([row({ status })]);
    const incoming = row({ fetchedAt: '2026-10-22T12:00:00Z', status: 'public' });
    const result = merged(base, [snapshot([incoming])]);
    assert.equal(result.records[0].status, status); assert.equal(result.merge.unavailableKept, 1);
    assert.equal(merged(base, [snapshot([{ ...incoming, liveVerified: true }])]).records[0].status, 'public');
    assert.equal(merged(base, [snapshot([{ ...incoming, liveVerified: true, fetchedAt: '2026-10-20T12:00:00Z' }])]).records[0].status, status);
  }
  const closed = merged(snapshot(), [snapshot([row({ status: 'closed', fetchedAt: '2026-10-22T12:00:00Z' })])]);
  assert.equal(closed.records[0].status, 'closed');
});

test('withdrawn records retain reference tombstones without original text, HTML or public profile details', () => {
  const result = merged(snapshot([row({ originalHtml: '<p>Private old content</p>', body: 'Private old content', profileUrl: 'https://news.ycombinator.com/user?id=requester' })]), [snapshot([row({ status: 'deleted', fetchedAt: '2026-10-22T12:00:00Z' })])]);
  const record = result.records[0];
  assert.equal(record.id, 'hn:12345'); assert.equal(record.date, row().date); assert.equal(record.url, row().url); assert.equal(record.redacted, true); assert.equal(record.author, '');
  for (const field of ['originalHtml', 'body', 'profileUrl']) assert.equal(record[field], undefined);
  assert.equal(record.request, null); assert.equal(record.text, 'This source is unavailable.');
  assert.equal(merged(result, [snapshot([row()])]).records[0].status, 'deleted');
});

test('numeric X account identity and all license provenance survive canonical merges', () => {
  const numeric = archive();
  const usernameOnly = { ...numeric, id: 'x:import:duplicate', authorId: 'x:requester', collection: { provider: 'public-dataset' }, dataset: { name: 'Another public source', url: 'https://publisher.example/posts', license: 'CC BY-NC 4.0' } };
  const result = merged(snapshot([usernameOnly]), [snapshot([numeric])]);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].id, usernameOnly.id); assert.equal(result.records[0].authorId, numeric.authorId);
  assert.deepEqual(result.records[0].datasets.map(item => item.license), ['CC BY-NC 4.0', 'Original author rights apply.']);
  assert.equal(typeof result.records[0].authorId, 'string');
  assert.throws(() => merged(snapshot([numeric]), [snapshot([{ ...numeric, dataset: { ...numeric.dataset, exportId: 'new' } }])]), /Community Archive refresh rejected/);
});

test('unchanged Community Archive selections roundtrip, including corpus expansions that also contain those records', () => {
  const original = archive(), base = snapshot([original]);
  const incoming = snapshot([{ ...original, fetchedAt: '2026-10-22T12:00:00Z' }, row()]);
  const result = merged(base, [incoming]);
  assert.equal(result.records.length, 2); assert.equal(result.records[0].authorId, original.authorId);
  assert.equal(merged(result, [snapshot([result.records[0], row({ id: 'hn:12346', url: 'https://news.ycombinator.com/item?id=12346' })])]).records.length, 3);
  assert.equal(merged(base, [snapshot([original, original])]).records.length, 1);
});

test('Community Archive changed exports, consent snapshots, text or partial selections fail closed', () => {
  const first = archive(), second = archive({ id: 'x:1987654321234567891', url: 'https://x.com/requester/status/1987654321234567891' });
  const base = snapshot([first, second]);
  for (const input of [snapshot([first]), snapshot([{ ...first, text: 'I need a completely different tool to automate our existing calendar.', }, second]), snapshot([{ ...first, dataset: { ...first.dataset, sourceChecksum: 'b'.repeat(64) } }, { ...second, dataset: { ...second.dataset, sourceChecksum: 'b'.repeat(64) } }]), snapshot([{ ...first, dataset: { ...first.dataset, consentSnapshotAt: '2026-10-23T00:00:00Z' } }, { ...second, dataset: { ...second.dataset, consentSnapshotAt: '2026-10-23T00:00:00Z' } }]), snapshot([], { dataset: first.dataset })]) assert.throws(() => merged(base, [input]), /Community Archive.*(?:refresh|selection)/);
  assert.equal(base.records.length, 2); assert.equal(base.records[0].text, first.text);
});

test('invalid original metadata, synthetic data and conflicting source identities fail validation', () => {
  for (const patch of [{ id: 12345 }, { id: 'hn:12346' }, { url: 'https://news.ycombinator.com/user?id=requester' }, { url: 'http://news.ycombinator.com/item?id=12345' }, { url: 'https://news.ycombinator.com.evil.example/item?id=12345' }, { author: '[deleted]' }, { authorId: 123 }, { authorId: 'hn:' }, { date: 'not-a-date' }, { date: '2030-01-01T00:00:00Z' }, { text: 'too short' }, { synthetic: true }, { origin: 'dataset' }, { origin: 'dataset', dataset: { name: 'Missing license', url: 'https://publisher.example/data' } }]) assert.throws(() => validateNormalizedRecord(row(patch), { now }));
  assert.throws(() => merged(snapshot(), [snapshot([row({ url: 'https://news.ycombinator.com/item?id=12346', id: 'hn:import:collision' }), row({ id: 'hn:import:collision' })])]), /multiple original posts/);
  assert.throws(() => merged(snapshot(), [snapshot([row({ date: '2026-10-02T12:00:00Z' })])]), /Conflicting original post dates/);
  assert.throws(() => merged(snapshot(), [[]]), /normalized JSON object/);
});

test('invalid legacy non-post rows are rejected with receipts, while invalid archive rows fail the whole selection', () => {
  const communityPage = reddit({ id: 'reddit:t5_community', url: 'https://www.reddit.com/r/software/' });
  const base = snapshot([row(), communityPage]);
  const result = merged(base, [snapshot([communityPage])]);
  assert.equal(result.records.length, 1); assert.equal(result.merge.rejectedRows, 2); assert.equal(result.merge.rejectedSources, 1);
  assert.equal(result.merge.rejected[0].id, communityPage.id); assert.match(result.merge.rejected[0].error, /original post or comment ID/);
  assert.throws(() => merged(snapshot(), [snapshot([archive({ authorId: 987654321123456789 })])]), /stable string authorId|numeric account IDs/);
});

test('CLI merges normalized files atomically without modifying base or input and reports pending reanalysis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-merge-'));
  try {
    const base = join(directory, 'base.json'), input = join(directory, 'input.json'), output = join(directory, 'staging.json');
    const baseText = JSON.stringify(snapshot()), inputText = JSON.stringify(snapshot([row({ id: 'hn:12346', url: 'https://news.ycombinator.com/item?id=12346' })]));
    await writeFile(base, baseText); await writeFile(input, inputText);
    const run = spawnSync(process.execPath, ['scripts/merge.mjs', '--base', base, '--input', input, '--output', output], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.records.length, 2); assert.equal(result.analysis.status, 'pending'); assert.equal(JSON.parse(run.stdout).added, 1);
    assert.equal(await readFile(base, 'utf8'), baseText); assert.equal(await readFile(input, 'utf8'), inputText);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI rejects seed, state, corpus and input destinations, including symbolic aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-merge-protected-'));
  try {
    const base = join(directory, 'base.json'), input = join(directory, 'input.json'), state = join(directory, 'state.json'), alias = join(directory, 'alias.json');
    const original = JSON.stringify(snapshot()); await Promise.all([base, input, state].map(path => writeFile(path, original))); await symlink(state, alias);
    for (const output of [base, input, alias, state, join(directory, 'seed.json'), join(directory, 'corpus.json')]) {
      const run = spawnSync(process.execPath, ['scripts/merge.mjs', '--base', base, '--input', input, '--output', output], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
      assert.notEqual(run.status, 0); assert.match(run.stderr, /Refusing to overwrite|output must be separate/);
    }
    assert.equal(await readFile(base, 'utf8'), original); assert.equal(await readFile(input, 'utf8'), original); assert.equal(await readFile(state, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a rejected archive refresh never replaces an existing staging output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-merge-failed-'));
  try {
    const base = join(directory, 'base.json'), input = join(directory, 'input.json'), output = join(directory, 'staging.json');
    const first = archive(), next = archive({ dataset: { ...archive().dataset, exportId: '2026-10-23' } });
    await writeFile(base, JSON.stringify(snapshot([first]))); await writeFile(input, JSON.stringify(snapshot([next]))); await writeFile(output, 'previous staging output');
    const run = spawnSync(process.execPath, ['scripts/merge.mjs', '--base', base, '--input', input, '--output', output], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.notEqual(run.status, 0); assert.match(run.stderr, /Community Archive refresh rejected/);
    assert.equal(await readFile(output, 'utf8'), 'previous staging output');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
