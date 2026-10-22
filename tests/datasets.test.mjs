import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveRecord, communityArchiveRecord, redditDatasetRecord, collectArchiveRequests, REDDIT_ARCHIVE } from '../server/datasets.mjs';

const now = Date.parse('2026-10-22T12:00:00Z');
const row = (overrides = {}) => ({ id: 'abc123', author: 'ActualRequester', subreddit: 'selfhosted', title: 'Looking for a PDF search tool', selftext: 'I need a local tool to search the text inside all of my PDF documents without uploading the documents to a cloud service.', created_utc: now / 1000 - 86400, retrieved_on: now / 1000 - 3000, permalink: '/r/selfhosted/comments/abc123/pdf_search/', ...overrides });

test('archive normalization preserves literal text, original identity, date, and provenance', () => {
  const source = archiveRecord(row(), { now, query: 'pdf', endpoint: 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=selfhosted&query=pdf' });
  assert.equal(source.source, 'reddit');
  assert.equal(source.authorId, 'reddit:actualrequester');
  assert.equal(source.text, row().selftext);
  assert.equal(source.date, new Date(now - 86400000).toISOString());
  assert.equal(source.url, 'https://www.reddit.com/r/selfhosted/comments/abc123/pdf_search/');
  assert.equal(source.dataset.url, REDDIT_ARCHIVE.url);
  assert.equal(source.dataset.liveVerified, false);
  assert.match(source.dataset.license, /No archive content license specified/);
  assert.equal(source.signalId, undefined);
  assert.equal(source.collection.query, 'pdf');
});

test('removed, deleted, restricted, NSFW, and authorless archive posts never become leads', () => {
  for (const changed of [{ author: '[deleted]' }, { selftext: '[removed]' }, { removed_by_category: 'moderator' }, { over_18: true }, { quarantine: true }, { subreddit_type: 'private' }, { is_robot_indexable: false }, { author: 'AutoModerator' }, { author: '' }, { _meta: { was_deleted_later: true } }]) assert.equal(archiveRecord(row(changed), { now }), null);
});

test('documented archive restoration uses updated title and distinguishes later deletion', () => {
  const original = row({ title: '[ Removed by moderator ]', removed_by_category: 'moderator', is_robot_indexable: false, _meta: { was_initially_deleted: true, edited_title: 'Looking for a local PDF search app', retrieved_2nd_on: now / 1000 - 2000 } });
  const restored = archiveRecord(original, { now });
  assert.equal(restored.title, 'Looking for a local PDF search app');
  assert.equal(restored.dataset.restoredAfterModeration, true);
  assert.equal(archiveRecord({ ...original, _meta: { ...original._meta, was_deleted_later: true } }, { now }), null);
});

test('unrelated discussion and clear promotion are not collected as asks', () => {
  assert.equal(archiveRecord(row({ title: 'I launched our PDF tool', selftext: 'I built a software tool to search PDF files. Try our product and tell me what you wish it could do.' }), { now }), null);
  assert.equal(archiveRecord(row({ title: 'PDF tool released', selftext: 'This software release has many useful improvements and a new color theme for the dashboard.' }), { now }), null);
  assert.equal(archiveRecord(row({ created_utc: now / 1000 + 10000 }), { now }), null);
  assert.equal(archiveRecord(row({ created_utc: now / 1000 - 864000 }), { now, minimumDate: now - 86400000 }), null);
});

test('archive URL validation prevents forged original links', () => {
  assert.equal(archiveRecord(row({ permalink: 'https://example.com/r/selfhosted/comments/abc123/' }), { now }), null);
  assert.equal(archiveRecord(row({ permalink: '/r/selfhosted/comments/different/' }), { now }), null);
  assert.equal(archiveRecord(row({ subreddit: '../../profile' }), { now }), null);
});

test('bounded archive collection deduplicates canonical posts and stages snapshots without mutating app state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-dataset-test-'));
  const requested = [];
  try {
    const result = await collectArchiveRequests(directory, () => {}, { now: () => now, lanes: [{ subreddit: 'selfhosted', query: 'pdf', pages: 4 }, { subreddit: 'software', query: 'pdf', pages: 4 }], maxRequests: 2, delayMs: 0, fetch: async url => { requested.push(String(url)); return new Response(JSON.stringify({ data: [row()] }), { status: 200 }); } });
    assert.equal(result.records.length, 1);
    assert.equal(result.report.requests, 2);
    assert.equal(result.report.scanned, 2);
    assert.equal(requested.length, 2);
    assert.equal(JSON.parse(await readFile(join(directory, 'reddit-archive.json'), 'utf8')).records.length, 1);
    await assert.rejects(readFile(join(directory, 'state.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('access denial or rate limiting stops all subsequent archive lanes', async () => {
  for (const status of [401, 403, 429]) {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-dataset-limit-'));
    let requests = 0;
    try {
      const result = await collectArchiveRequests(directory, () => {}, { now: () => now, lanes: [{ subreddit: 'selfhosted', pages: 4 }, { subreddit: 'software', pages: 4 }], delayMs: 0, fetch: async () => { requests++; return new Response('', { status, headers: { 'Retry-After': '120' } }); } });
      assert.equal(requests, 1);
      assert.equal(result.report.stopped, true);
      assert.equal(result.report.errors[0].status, status);
      if (status === 429) assert.equal(result.report.errors[0].retryAt, new Date(now + 120000).toISOString());
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('same-day cached collection avoids repeat API requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-dataset-cache-'));
  try {
    const options = { now: () => now, lanes: [{ subreddit: 'selfhosted', pages: 1 }], delayMs: 0, fetch: async () => new Response(JSON.stringify({ data: [row()] }), { status: 200 }) };
    await collectArchiveRequests(directory, () => {}, options);
    const result = await collectArchiveRequests(directory, () => {}, { ...options, fetch: async () => { throw new Error('Cache should avoid this request'); } });
    assert.equal(result.report.requests, 0);
    assert.equal(result.report.cacheHits, 1);
    assert.equal(result.records.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const manifest = { export_id: '2026-10-22T07-09-36Z', publication: { status: 'published' }, consent: { snapshot_at: '2026-10-22 07:17:40.522' }, files: { tweets: { sha256: 'verified-export-hash' } } };
const tweet = (overrides = {}) => ({ tweet_id: '1980000000000000123', account_id: '123456789', username: 'PublicRequester', created_at: '2026-10-20 08:00:00.000', full_text: 'I wish there was a tool that let me search the full text of all my local PDF documents offline.', ...overrides });

test('consent-managed X normalization retains exact post ID, numeric account identity, and original text', () => {
  const result = communityArchiveRecord(tweet(), manifest, { now, eligibleAccountIds: new Set(['123456789']) });
  assert.equal(result.url, 'https://x.com/PublicRequester/status/1980000000000000123');
  assert.equal(result.authorId, 'x:123456789');
  assert.equal(result.text, tweet().full_text);
  assert.equal(result.date, '2026-10-20T08:00:00.000Z');
  assert.equal(result.dataset.consentSnapshotAt, manifest.consent.snapshot_at);
  assert.equal(result.dataset.sourceChecksum, 'verified-export-hash');
  assert.equal(result.signalId, undefined);
});

test('X archive ignores retweets, lost-precision IDs, opt-outs, withdrawn exports, and stale posts', () => {
  for (const change of [{ tweet_id: 1980000000000000123 }, { account_id: 123456789 }, { retweeted_tweet_id: '1234567890000' }, { full_text: 'RT @requester: I wish there was a software tool to search all my PDF documents.' }, { opted_out: true }, { deleted: true }, { created_at: '2022-01-01 00:00:00' }]) assert.equal(communityArchiveRecord(tweet(change), manifest, { now }), null);
  assert.equal(communityArchiveRecord(tweet(), { ...manifest, publication: { status: 'withdrawn' } }, { now }), null);
  assert.equal(communityArchiveRecord(tweet(), manifest, { now, eligibleAccountIds: new Set(['other']) }), null);
});

test('public Reddit comment datasets retain reply permalinks and cannot inherit a request from the parent title', () => {
  const metadata = { name: 'Public research sample', url: 'https://huggingface.co/datasets/example/sample', license: 'CC BY-NC 4.0; original author rights retained', revision: 'fixed-revision', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/' };
  const input = { id: 'comment123', author: 'RealRequester', record_type: 'comment', created_utc: now / 1000 - 1000, title: 'Looking for persistent agent memory software', body: 'I need a tool that stores agent memory between sessions without uploading my private documents.', permalink: '/r/LocalLLaMA/comments/post123/agent_memory/comment123/' };
  const result = redditDatasetRecord(input, metadata, { now });
  assert.equal(result.recordType, 'comment');
  assert.equal(result.url, 'https://www.reddit.com/r/LocalLLaMA/comments/post123/agent_memory/comment123/');
  assert.equal(result.text, input.body);
  assert.equal(result.dataset.revision, 'fixed-revision');
  assert.equal(result.dataset.license, metadata.license);
  assert.equal(redditDatasetRecord({ ...input, body: 'That software article was very interesting and the explanation helped me understand the design.' }, metadata, { now }), null);
  assert.equal(redditDatasetRecord({ ...input, body: '[removed]' }, metadata, { now }), null);
});
