import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { detectRequest, priorityTier } from '../server/requests.mjs';
import { clusterRequests, requestRecords, summarizeSignal, recountSignals } from '../server/signals.mjs';
import { canonicalSourceUrl, citedSourceIds } from '../shared/citations.mjs';
import { importDataset, normalizeImportedRow } from '../server/imports.mjs';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 86400000;
const post = (id, overrides = {}) => ({
  id, source: 'github', author: id, authorId: `github:${id}`,
  title: 'Feature request: persistent agent memory',
  text: 'I need a tool that keeps agent memory between sessions.',
  url: `https://github.com/example/agent/issues/${id}`,
  threadUrl: `https://github.com/example/agent/issues/${id}`,
  date: NOW.toISOString(), status: 'open', topicId: 'agents',
  recordType: 'post', origin: 'live-api', ...overrides,
});
const summarize = records => summarizeSignal(
  { sourceIds: records.map(record => record.id), representativeId: records[0]?.id },
  new Map(records.map(record => [record.id, record])), NOW,
);
const metadata = { source: 'x', name: 'Public software request sample', url: 'https://datasets.example/posts', license: 'CC BY 4.0' };
const importedPost = (overrides = {}) => ({
  author: 'requester', url: 'https://x.com/requester/status/1234567890',
  date: NOW.toISOString(), text: 'I need a tool that keeps agent memory between sessions.', ...overrides,
});

test('signal counts unique platform authors while preserving their independent requests', () => {
  const records = [post('1', { authorId: 'github:alice' }), post('2', { authorId: 'github:alice' }), post('3', { authorId: 'github:bob' })];
  const signal = summarize(records);
  assert.equal(signal.requesterCount, 2);
  assert.equal(signal.allTimeCount, 2);
  assert.deepEqual(signal.sourceIds, ['1', '2', '3']);
});

test('the same short ask from different authors remains independent evidence', () => {
  const records = [post('1'), post('2')];
  assert.equal(requestRecords(records).length, 2);
  assert.equal(summarize(records).requesterCount, 2);
});

test('URL aliases and copied long cross-posts do not inflate request counts', () => {
  const longText = 'I need a tool that preserves agent memory, records every tool result and restores the correct conversation state when a session is restarted. Our current workaround is to manually copy results into another document before every restart.';
  const first = post('1', { text: longText });
  const alias = post('alias', { url: `${first.url}?utm_source=newsletter`, text: 'I need a tool to store agent results.' });
  const copy = post('copy', { text: longText.toUpperCase() });
  assert.deepEqual(requestRecords([first, alias, copy]).map(record => record.id), ['1']);
});

test('the rolling 365-day window includes both boundaries and excludes old, future and invalid dates', () => {
  const records = [
    post('boundary', { date: new Date(NOW.getTime() - 365 * DAY).toISOString() }),
    post('now'),
    post('old', { date: new Date(NOW.getTime() - 365 * DAY - 1).toISOString() }),
    post('future', { date: new Date(NOW.getTime() + 1).toISOString() }),
    post('invalid', { date: 'not-a-date' }),
  ];
  const signal = summarize(records);
  assert.equal(signal.requesterCount, 2);
  assert.equal(signal.windowDays, 365);
  assert.equal(signal.asOf, NOW.toISOString());
  assert.ok(!signal.sourceIds.includes('invalid'));
});

test('archive and payment counts deduplicate authors inside the date window', () => {
  const records = [
    post('1', { origin: 'dataset', authorId: 'github:alice', text: 'I would pay for a tool that keeps agent memory between sessions.' }),
    post('2', { origin: 'dataset', authorId: 'github:alice', text: 'I would pay for an agent memory tool with reliable checkpoints.' }),
    post('3', { origin: 'dataset' }),
    post('4', { origin: 'dataset', date: new Date(NOW.getTime() - 366 * DAY).toISOString(), text: 'I would pay for a reliable tool to restore agent sessions.' }),
  ];
  const signal = summarize(records);
  assert.equal(signal.archiveCount, 2);
  assert.equal(signal.paymentMentions, 1);
});

test('tiers change at 10, 20 and 50 distinct recent requesters', () => {
  for (const [count, tier, nextAt] of [[0, 'early', 10], [9, 'early', 10], [10, 'recurring', 20], [19, 'recurring', 20], [20, 'growing', 50], [49, 'growing', 50], [50, 'strong', null]]) {
    assert.equal(priorityTier(count).id, tier, `${count} requesters`);
    assert.equal(priorityTier(count).nextAt, nextAt);
    if (count) assert.equal(summarize(Array.from({ length: count }, (_, i) => post(String(i)))).tier.id, tier);
  }
});

test('semantic chain guard keeps dissimilar endpoints out of the same request group', () => {
  const records = [post('start'), post('bridge'), post('end')];
  // Unit vectors: start resembles bridge, and bridge resembles end, but the endpoints differ.
  const vectors = [[1, 0], [.8, .6], [.6, .8]];
  const groups = clusterRequests(records, vectors);
  assert.deepEqual(groups.map(group => group.sourceIds), [['start', 'bridge'], ['end']]);
  // This fixture would merge through the moving centroid without the anchor constraint.
  assert.equal(clusterRequests(records, vectors, { minAnchorSimilarity: 0 }).length, 1);
});

test('promotion, hiring, advice and generic software discussion are not requests', () => {
  const nonRequests = [
    { title: 'Show HN: our new tool', text: 'I built an app for agent memory. I would love to hear what you think.' },
    { title: 'Ask HN: Who is hiring?', text: 'We need an app developer for our agent platform.' },
    { title: 'Looking for advice on deployment', text: 'I need advice on how to deploy an existing app.' },
    { title: 'Agent memory observations', text: 'Persistent memory is an interesting feature of this software platform.' },
    { title: 'Seeking beta users for an app', text: 'We launched a tool and are looking for beta users to test its integration.' },
  ];
  for (const [i, record] of nonRequests.entries()) assert.equal(detectRequest(post(String(i), record)), null, record.title);
});

test('gratitude containing an ask-like phrase is not a product request', () => {
  assert.equal(detectRequest(post('thanks', { title: 'Thanks for this release', text: 'I would like to thank the developers for maintaining this useful tool.' })), null);
});

test('GitHub checklists before the feature description never become the request quote', () => {
  const requestedBehavior = 'Please add persistent agent memory so tool results survive session restarts.';
  const text = [
    '### Checked other resources',
    '- [x] I searched existing issues for this tool.',
    '- [x] I need to complete this template before submitting an issue.',
    '',
    '### Feature Description',
    requestedBehavior,
    '',
    '### Motivation',
    'An agent restart should not erase recorded tool results.',
  ].join('\n');
  const request = detectRequest(post('template', { text }));
  assert.equal(request?.type, 'feature_request');
  assert.ok(request.quote.startsWith(requestedBehavior));
  assert.doesNotMatch(request.quote, /\[x\]|complete this template|searched existing issues|Checked other resources/);
});

test('endorsements, bots and unavailable content cannot promote a signal', () => {
  const endorsement = post('1', { recordType: 'comment', text: '+1' });
  assert.equal(detectRequest(endorsement)?.type, 'endorsement');
  assert.deepEqual(requestRecords([
    endorsement, post('2', { author: 'AutoModerator' }), post('3', { status: 'deleted' }),
    post('4', { status: 'closed' }), post('5', { status: 'removed' }),
    post('6', { synthetic: true }), post('7', { authorId: '' }),
  ]), []);
});

test('citation canonicalization handles platform aliases while preserving distinct comments', () => {
  assert.equal(canonicalSourceUrl('http://www.news.ycombinator.com/item?id=123&ref=front'), 'hn:123');
  assert.equal(canonicalSourceUrl('https://www.github.com/Example/Repo/issues/12/?utm_source=mail#issuecomment-42'), 'github:/example/repo/issues/12#issuecomment-42');
  assert.notEqual(canonicalSourceUrl('https://github.com/example/repo/issues/12'), canonicalSourceUrl('https://github.com/example/repo/issues/12#issuecomment-42'));
  assert.equal(canonicalSourceUrl('https://twitter.com/oldname/status/123?s=20'), canonicalSourceUrl('https://x.com/newname/status/123'));
  assert.equal(canonicalSourceUrl('http://www.example.com/post?utm_source=mail&ref=front&topic=agents#reply'), 'https://example.com/post?topic=agents');
  for (const value of ['not a URL', 'javascript:alert(1)', 'file:///tmp/post']) assert.equal(canonicalSourceUrl(value), null);
});

test('HN citation URLs need an original item ID', () => {
  assert.equal(canonicalSourceUrl('https://news.ycombinator.com/item'), null);
});

test('citations resolve original source aliases and ignore unknown URLs', () => {
  const records = [post('1'), post('2', { source: 'x', url: 'https://x.com/requester/status/123' })];
  const text = `Evidence: [source](${records[0].url}?utm_source=test), https://twitter.com/requester/status/123. Also https://github.com/example/agent/issues/999`;
  assert.deepEqual(new Set(citedSourceIds(text, records)), new Set(['1', '2']));
});

test('dataset normalization preserves mapped provenance, original dates and author identity', () => {
  const row = { who: '@requester', when: Math.floor(NOW.getTime() / 1000), body_copy: 'I need a tool that preserves agent memory between sessions.', link: 'https://twitter.com/requester/status/1234567890', headline: 'A software request', profile_link: 'https://x.com/requester' };
  const normalized = normalizeImportedRow(row, { ...metadata, source: 'twitter' }, { author: 'who', date: 'when', text: 'body_copy', url: 'link', title: 'headline', profile: 'profile_link' });
  assert.equal(normalized.source, 'x');
  assert.equal(normalized.author, 'requester');
  assert.equal(normalized.date, NOW.toISOString());
  assert.equal(normalized.origin, 'dataset');
  assert.equal(normalized.dataset.url, metadata.url);
  assert.equal(normalized.dataset.license, metadata.license);
  assert.equal(normalized.profileUrl, row.profile_link);
  assert.ok(normalized.request);
  assert.equal(normalizeImportedRow(importedPost({ date: NOW.getTime() }), metadata).date, NOW.toISOString());
});

test('dataset imports reject missing provenance fields, profile dumps and invalid post data', () => {
  for (const [row, source, message] of [
    [{ author: '' }, 'x', /public author/],
    [{ author: '[deleted]' }, 'x', /public author/],
    [{ text: 'Too short' }, 'x', /Request text/],
    [{ date: 'not-a-date' }, 'x', /post date/],
    [{ url: 'http://x.com/requester/status/123' }, 'x', /does not match/],
    [{ url: 'https://github.com/requester' }, 'x', /does not match/],
    [{ url: 'https://x.com/requester' }, 'x', /status ID/],
    [{ url: 'https://www.linkedin.com/in/requester/' }, 'linkedin', /profile rows/],
    [{ url: 'https://www.reddit.com/user/requester/' }, 'reddit', /post URL/],
    [{ synthetic: true }, 'x', /Synthetic/],
  ]) assert.throws(() => normalizeImportedRow(importedPost(row), { ...metadata, source }), message);
  assert.throws(() => normalizeImportedRow(importedPost(), { ...metadata, source: 'unsupported' }), /Unsupported platform/);
});

test('synthetic flags serialized by CSV are still rejected', () => {
  for (const row of [{ synthetic: 'true' }, { is_synthetic: 'true' }]) {
    assert.throws(() => normalizeImportedRow(importedPost(row), metadata), /Synthetic/);
  }
});

test('file imports validate dataset provenance before reading a file', async () => {
  for (const field of ['name', 'url', 'license']) await assert.rejects(importDataset('/missing/posts.json', { ...metadata, [field]: '' }), /required for provenance/);
  await assert.rejects(importDataset('/missing/posts.json', { ...metadata, url: 'http://datasets.example/posts' }), /must be HTTPS/);
});

test('a dataset source URL must be a valid HTTPS URL, not just an HTTPS prefix', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-import-url-'));
  try {
    const file = resolve(directory, 'posts.json');
    await writeFile(file, JSON.stringify([importedPost()]));
    await assert.rejects(importDataset(file, { ...metadata, url: 'https://' }), /source page|URL|HTTPS/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('file imports report duplicate aliases and rejected rows without importing profile dumps', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-import-report-'));
  try {
    const file = resolve(directory, 'posts.jsonl');
    const rows = [importedPost(), importedPost({ url: 'https://twitter.com/requester/status/1234567890?utm_source=archive' }), importedPost({ url: 'https://x.com/requester' })];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const result = await importDataset(file, metadata);
    assert.equal(result.records.length, 1);
    assert.equal(result.report.read, 3);
    assert.equal(result.report.accepted, 1);
    assert.equal(result.report.duplicates, 1);
    assert.equal(result.report.rejected['X post URL is missing a status ID'], 1);
    await assert.rejects(importDataset(file, metadata, {}, 2), /limited to 2 rows/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CSV imports reject synthetic rows and accept explicit column mappings', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-import-csv-'));
  try {
    const file = resolve(directory, 'posts.csv');
    await writeFile(file, 'who,when,body_copy,link,synthetic\nrequester,2026-10-22T12:00:00Z,I need a tool that preserves agent memory between sessions.,https://x.com/requester/status/123,false\nother,2026-10-22T12:00:00Z,I need a tool that preserves agent memory between sessions.,https://x.com/other/status/456,true\n');
    const result = await importDataset(file, metadata, { author: 'who', date: 'when', text: 'body_copy', url: 'link' });
    assert.equal(result.report.accepted, 1);
    assert.equal(result.report.rejected['Synthetic records do not count as user requests'], 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('a source recheck removes closed evidence from request priority', () => {
  const records = [post('active'), post('closed', { status: 'closed' })];
  const original = { topics: [], records, signals: [{ id: 'signal:kept', representativeId: 'active', sourceIds: ['active', 'closed'], requesterCount: 2 }], analysis: { requestCount: 2, distinctAuthors: 2 } };
  const updated = recountSignals(original);
  assert.equal(updated.signals[0].requesterCount, 1);
  assert.equal(updated.analysis.requestCount, 1);
  assert.equal(updated.records[1].request, null);
  assert.equal(updated.records[1].signalId, null);
});

test('a software thread title cannot turn an unrelated wish into demand', () => {
  assert.equal(detectRequest(post('context', { source: 'hn', recordType: 'comment', title: 'New AI agent software', text: 'I wish the boosters would leave me behind already. I have been waiting for years.' })), null);
  assert.equal(detectRequest(post('show', { source: 'hn', title: 'Show HN: An app to organize calendar events', text: 'Would love to hear feedback on this app and its calendar integration.' })), null);
});


test('platform username casing cannot inflate recent requester counts', () => {
  const signal = summarize([post('a', { authorId: 'github:Alice' }), post('b', { authorId: 'github:alice' })]);
  assert.equal(signal.requesterCount, 1);
});

test('all dataset platforms require content URLs rather than profile pages', () => {
  for (const [source, url] of [['github', 'https://github.com/requester'], ['hn', 'https://news.ycombinator.com/user?id=requester'], ['stackexchange', 'https://softwarerecs.stackexchange.com/users/1/requester']]) {
    assert.throws(() => normalizeImportedRow(importedPost({ url }), { ...metadata, source }), /URL is required/);
  }
});
