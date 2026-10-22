import test from 'node:test';
import assert from 'node:assert/strict';
import { expansionPlan, collectHnDateWindows, expandPublicRequests } from '../server/expansion.mjs';

const hit = (id, text = 'I need a ChatGPT tool that can search old conversations by their content.') => ({ objectID: String(id), author: `requester${id}`, story_title: 'Searching AI conversations', comment_text: text, story_id: '42', created_at: new Date(Date.now() - 86400000).toISOString() });
const bounds = url => new URL(url).searchParams.get('numericFilters').match(/created_at_i>=(\d+),created_at_i<(\d+)/).slice(1).map(Number);

test('expansion plans use concrete workflow paraphrases without preassigned groups', () => {
  const plan = expansionPlan({ families: ['chat-history', 'calendar-sync'] });
  assert.ok(plan.hn.some(row => row.query === 'chatgpt old chats'));
  assert.ok(plan.hn.some(row => row.query === 'calendar free busy'));
  assert.equal(plan.families.length, 2); assert.ok(plan.broad.length > 5);
  assert.ok(!plan.hn.some(row => row.sourceIds || row.problemId));
  assert.throws(() => expansionPlan({ families: ['invented'] }), /existing expansion family/);
});

test('HN result caps split into adjacent date windows instead of silently losing older hits', async () => {
  const calls = [], received = [];
  const client = { disabled: () => false, request: async (_provider, url) => {
    const [from, to] = bounds(url); calls.push([from, to]);
    return { hits: [hit(from + 1)], nbHits: to - from === 400 ? 2001 : 1, hitsPerPage: 1000, nbPages: 1 };
  } };
  const result = await collectHnDateWindows('chatgpt history', { client, from: 0, to: 400, minWindowSeconds: 1, onHits: hits => received.push(...hits) });
  assert.deepEqual(calls, [[0, 400], [200, 400], [0, 200]]);
  assert.equal(result.requests, 3); assert.equal(result.incomplete, false);
  assert.equal(result.windows.filter(row => row.split).length, 1); assert.equal(received.length, 3);
});

test('HN leaf pagination and hard request bounds report incomplete coverage honestly', async () => {
  const calls = [];
  const client = { disabled: () => false, request: async (_provider, url) => {
    const page = Number(new URL(url).searchParams.get('page')); calls.push(page);
    return { hits: Array.from({ length: page === 2 ? 50 : 100 }, (_, i) => hit(page * 100 + i)), nbHits: 250, nbPages: 3, hitsPerPage: 100 };
  } };
  const partial = await collectHnDateWindows('search pdf', { client, from: 0, to: 100, maxRequests: 2, pageSize: 100 });
  assert.deepEqual(calls, [0, 1]); assert.equal(partial.incomplete, true);
  calls.length = 0;
  const complete = await collectHnDateWindows('search pdf', { client, from: 0, to: 100, maxRequests: 3, pageSize: 100 });
  assert.deepEqual(calls, [0, 1, 2]); assert.equal(complete.rawHits, 250); assert.equal(complete.incomplete, false);
});

test('unavoidable dense one-day windows remain explicitly truncated', async () => {
  const client = { disabled: () => false, request: async () => ({ hits: [hit(1)], nbHits: 5000, hitsPerPage: 1000, nbPages: 1 }) };
  const result = await collectHnDateWindows('software', { client, from: 0, to: 86400 });
  assert.equal(result.windows[0].truncated, true); assert.equal(result.windows[0].split, false);
});

test('expansion stores authored ask candidates with provenance and deduplicates canonical URLs', async () => {
  const first = { id: 'saved-source', source: 'hn', url: 'https://news.ycombinator.com/item?id=1', title: 'Searching AI conversations', text: hit(1).comment_text, author: 'requester1', authorId: 'hn:requester1', date: hit(1).created_at };
  const previous = { records: [first], marker: 'keep state outside collection' };
  const client = { attempts: [], disabled: () => false, request: async () => ({ hits: [hit(1), hit(2), hit(3, 'I built our app for ChatGPT search. Try my app and become an early adopter.'), hit(4, '<blockquote>I need a ChatGPT tool that searches old conversations.</blockquote><p>+1</p>')], nbHits: 4, nbPages: 1, hitsPerPage: 1000 }) };
  const result = await expandPublicRequests(previous, () => {}, { families: ['chat-history'], providers: ['hn'], broad: false, client, hnRequests: 30, maxNewRecords: 20 });
  assert.equal(previous.records.length, 1); assert.equal(result.records.length, 2);
  assert.equal(result.records.find(record => record.url.endsWith('id=1')).id, 'saved-source');
  const added = result.records.find(record => record.id === 'hn:2');
  assert.equal(added.collection.family, 'chat-history'); assert.equal(added.collection.stage, 'request-candidate');
  assert.equal(added.textScope, 'authored-unquoted'); assert.match(added.originalHtml, /I need a ChatGPT tool/);
  assert.equal(result.expansion.stats.added, 1); assert.equal(result.expansion.stats.uniqueAccounts, 1);
  assert.equal(result.marker, previous.marker); assert.ok(!added.signalId);
});

test('successful empty queries remain distinct from provider errors', async () => {
  let requests = 0;
  const client = { attempts: [], disabled: () => false, request: async () => { requests++; if (requests === 1) throw new Error('HN temporarily unavailable'); return { hits: [], nbHits: 0, nbPages: 0 }; } };
  const result = await expandPublicRequests({ records: [] }, () => {}, { families: ['chat-history'], providers: ['hn'], broad: false, client, hnRequests: 10 });
  assert.equal(result.records.length, 0); assert.equal(result.expansion.status, 'partial');
  assert.ok(result.expansion.health.some(row => row.status === 'error' && /unavailable/.test(row.error)));
  assert.ok(result.expansion.health.some(row => row.status === 'ok' && row.rawCount === 0));
});

test('cancellation in a deep HN query propagates without a staging checkpoint or result', async () => {
  const controller = new AbortController(); let requests = 0, checkpoints = 0;
  const client = { attempts: [], disabled: () => false, request: async () => { requests++; controller.abort(new Error('Stop expansion')); throw controller.signal.reason; } };
  await assert.rejects(expandPublicRequests({ records: [] }, () => {}, { families: ['chat-history'], providers: ['hn'], client, signal: controller.signal, onCheckpoint: async () => { checkpoints++; } }), /Stop expansion/);
  assert.equal(requests, 1); assert.equal(checkpoints, 0);
});

test('default expansion targets current 365-day evidence', () => {
  const plan = expansionPlan();
  assert.ok(Math.abs(plan.from - (Math.floor(Date.now() / 1000) - 365 * 86400)) <= 2);
});

test('contextual workflow asks are marked for model review without heuristic demand counts', async () => {
  const contextual = { ...hit(99, 'I wish we could search all our old conversations from one page.'), story_title: 'ChatGPT conversation history' };
  const client = { attempts: [], disabled: () => false, request: async () => ({ hits: [contextual], nbHits: 1, nbPages: 1 }) };
  const result = await expandPublicRequests({ records: [] }, () => {}, { client, families: ['chat-history'], providers: ['hn'], broad: false, hnRequests: 10 });
  assert.equal(result.records.length, 1); assert.equal(result.records[0].request, null);
  assert.equal(result.records[0].collectionCandidate.reason, 'explicit-workflow-ask');
  assert.equal(result.records[0].collectionCandidate.family, 'chat-history');
});

test('all providers obey the chosen date window and recent Reddit queries request t=year', async () => {
  const old = { ...hit(10), created_at: '2020-01-01T00:00:00Z' }, current = hit(11), redditUrls = [];
  const client = { attempts: [], disabled: () => false, request: async (provider, url) => {
    if (provider === 'reddit') { redditUrls.push(url); return []; }
    return { hits: [old, current], nbHits: 2, nbPages: 1 };
  } };
  const result = await expandPublicRequests({ records: [] }, () => {}, { client, families: ['chat-history'], providers: ['hn', 'reddit'], broad: false, hnRequests: 12, redditRequests: 3 });
  assert.deepEqual(result.records.map(record => record.id), ['hn:11']);
  assert.ok(result.expansion.stats.outsideWindow > 0);
  assert.ok(redditUrls.length > 0 && redditUrls.every(url => new URL(url).searchParams.get('t') === 'year'));
});
