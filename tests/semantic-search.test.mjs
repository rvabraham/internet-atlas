import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createNodeSearch, createNodeSnapshotCache } from '../server/semantic-search.mjs';

const chat = { workflow: 'Find earlier assistant conversations', problem: 'Long histories hide earlier decisions', desiredOutcome: 'Search past assistant conversations by meaning' };
const calendar = { workflow: 'Share calendar availability', problem: 'Sharing calendars exposes private event titles', desiredOutcome: 'Share available slots without exposing private titles' };
const record = (id, source = 'github', analysis = chat, changes = {}) => {
  const text = analysis === calendar ? 'I need to share available calendar slots without revealing my private event titles.' : 'I need to find decisions buried in my earlier assistant conversations.';
  return { id, source, author: `person-${id}`, authorId: `${source}:${id}`, title: `Feature request ${id}`, text, topicId: analysis === calendar ? 'calendar' : 'chat', status: 'open', date: '2026-10-20T12:00:00Z', problemAnalysis: analysis ? { ...analysis, classification: 'request', requesterRole: 'user', confidence: .95, evidenceQuote: text } : { classification: 'discussion', confidence: .95 }, ...changes };
};
function corpus() {
  return { records: [record('chat-gh'), record('chat-hn', 'hn'), record('calendar-hn', 'hn', calendar), record('redwood', 'reddit', null, { title: 'RedwoodDB indexing guide', text: 'A discussion of database indexes and query execution.' })], signals: [
    { id: 'problem:chat', label: 'Find old conversations', ...chat, reviewed: true, requesterCount: 2, sourceIds: ['chat-gh', 'chat-hn'] },
    { id: 'problem:calendar', label: 'Share available slots privately', ...calendar, reviewed: true, requesterCount: 1, sourceIds: ['calendar-hn'] },
  ] };
}
function fakeEmbed(vectorFor = text => /assistant|buried chat/i.test(text) ? [1, 0, 0] : /calendar|available slots|redwooddb$/i.test(text) ? [0, 1, 0] : [0, 0, 1]) {
  const fn = async (texts, directory, progress, options) => { fn.calls.push({ texts, directory, options }); progress?.({ completed: texts.length, total: texts.length }); return texts.map(vectorFor); };
  fn.calls = []; return fn;
}
async function local(run) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-node-search-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('semantic paraphrases find source and problem nodes, while exact lexical results survive a mismatched query vector', () => local(async directory => {
  const data = corpus(), embed = fakeEmbed(), index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const warmed = await index.prewarm();
  assert.equal(warmed.state, 'ready'); assert.equal(warmed.nodeCount, 6);
  assert.equal(embed.calls.length, 1);
  assert.equal(embed.calls[0].directory, resolve(directory, 'node-search'));
  assert.ok(embed.calls[0].texts.includes(`${chat.workflow}. ${chat.problem}. Desired outcome: ${chat.desiredOutcome}`));
  const paraphrase = await index.search('buried chat');
  assert.equal(paraphrase.method, 'hybrid'); assert.equal(paraphrase.state, 'ready');
  assert.deepEqual(new Set(paraphrase.results.map(row => row.id)), new Set(['chat-gh', 'chat-hn', 'problem:chat']));
  assert.ok(paraphrase.results.every(row => Object.keys(row).sort().join(',') === 'id,kind,score,sourceIds'));
  const lexical = await index.search('RedwoodDB');
  assert.equal(lexical.results[0].id, 'redwood');
  assert.equal(lexical.results[0].kind, 'source');
}));

test('topic and platform filters apply before ranking for both search and related nodes', () => local(async directory => {
  const data = corpus(), index = createNodeSearch({ getCorpus: () => data, directory, embed: fakeEmbed(() => [1, 0]) });
  const search = await index.search('buried chat', { sourceFilters: ['github'], limit: 80 });
  assert.deepEqual(new Set(search.results.map(row => row.id)), new Set(['chat-gh', 'problem:chat']));
  const related = await index.neighbors('chat-gh', { topicId: 'calendar', sourceFilters: ['hn'], limit: 2 });
  assert.deepEqual(new Set(related.results.map(row => row.id)), new Set(['calendar-hn', 'problem:calendar']));
  assert.ok(!related.results.some(row => row.id === 'chat-gh'));
  const none = await index.search('buried chat', { sourceFilters: ['x'] });
  assert.deepEqual(none.results, []);
}));

test('related semantics are navigation only and cannot merge different problems or change demand counts', () => local(async directory => {
  const data = corpus(), original = structuredClone(data);
  const embed = fakeEmbed(text => /assistant/i.test(text) ? [1, 0, 0] : /calendar|available slots/i.test(text) ? [.6, .8, 0] : [0, 0, 1]);
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const related = await index.neighbors('problem:chat');
  assert.equal(related.method, 'semantic');
  assert.ok(related.results.some(row => row.id === 'problem:calendar'));
  assert.ok(!related.results.some(row => row.id === 'problem:chat' || row.id === 'redwood'));
  assert.deepEqual(data, original);
}));

test('unavailable sources and unsupported problem members are excluded even if data changes in place', () => local(async directory => {
  const data = corpus(), index = createNodeSearch({ getCorpus: () => data, directory, embed: fakeEmbed(() => [1, 0]) });
  await index.prewarm();
  data.records[0].private = true;
  data.records[1].status = 'opted-out';
  data.records[2].synthetic = 'true';
  assert.equal(index.info().state, 'idle', 'Status detects invalidation before a caller chooses its cold-search fallback');
  assert.equal(index.info().indexedCount, 0);
  assert.equal(index.info().nodeCount, 1);
  const result = await index.search('node');
  assert.deepEqual(result.results.map(row => row.id), ['redwood']);
  assert.equal(index.info().nodeCount, 1);
}));

test('warm and concurrent queries reuse one build and normalized query embeddings', () => local(async directory => {
  const data = corpus(), embed = fakeEmbed(), index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const responses = await Promise.all([index.search(' Buried chat '), index.search('buried chat'), index.prewarm()]);
  assert.equal(responses[0].state, 'ready');
  assert.equal(embed.calls.length, 2, 'One corpus embedding batch and one normalized query embedding');
  assert.equal(embed.calls[0].options.persist, true);
  assert.equal(embed.calls[1].options.persist, false, 'New interactive queries bypass the full disk cache');
  await index.search('BURIED CHAT'); await index.neighbors('chat-gh');
  assert.equal(embed.calls.length, 2);
  assert.equal(index.info().indexedCount, 6);
}));

test('persisted content/model identities reuse unchanged node vectors and re-embed only changed content', () => local(async directory => {
  let data = corpus(); const embed = fakeEmbed();
  const first = createNodeSearch({ getCorpus: () => data, directory, embed });
  await first.prewarm(); assert.equal(embed.calls.length, 1);
  data = structuredClone(data);
  data.records[0].problemAnalysis.problem = 'Important earlier assistant decisions cannot be found';
  await first.prewarm(); assert.equal(embed.calls.length, 2); assert.equal(embed.calls[1].texts.length, 1);
  const reopened = createNodeSearch({ getCorpus: () => data, directory, embed });
  await reopened.prewarm(); assert.equal(embed.calls.length, 2, 'A new factory reuses persisted vectors');
  const path = resolve(directory, 'node-search/vectors.json');
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.revision = 'different-model-revision';
  await writeFile(path, JSON.stringify(saved));
  const changedModel = createNodeSearch({ getCorpus: () => data, directory, embed });
  await changedModel.prewarm(); assert.equal(embed.calls.length, 3); assert.equal(embed.calls[2].texts.length, 6);
}));

test('corpus replacement during a shared build cannot publish stale private sources', () => local(async directory => {
  let data = corpus(), release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const base = fakeEmbed(); let first = true;
  const embed = async (...args) => { if (first) { first = false; entered(); await gate; } return base(...args); };
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const warming = index.prewarm(); await started;
  assert.equal(index.info().state, 'indexing');
  data = { records: [record('new-chat')], signals: [] };
  const searching = index.search('buried chat'); release();
  const [, result] = await Promise.all([warming, searching]);
  assert.deepEqual(result.results.map(row => row.id), ['new-chat']);
  assert.equal(index.info().nodeCount, 1);
}));

test('embedding failures provide honest keyword fallback and explicit prewarm retries the failed build', () => local(async directory => {
  const data = corpus(); let failure = true, calls = 0;
  const base = fakeEmbed();
  const index = createNodeSearch({ getCorpus: () => data, directory, embed: async (...args) => { calls++; if (failure) throw new Error('Local model unavailable'); return base(...args); } });
  const result = await index.search('RedwoodDB');
  assert.equal(result.method, 'keyword'); assert.equal(result.state, 'degraded'); assert.equal(result.results[0].id, 'redwood');
  assert.match(index.info().error, /Local model unavailable/);
  await index.search('RedwoodDB'); assert.equal(calls, 1, 'Failed builds do not restart on each keystroke');
  failure = false;
  assert.equal((await index.prewarm()).state, 'ready');
  assert.equal((await index.search('buried chat')).method, 'hybrid');
}));

test('raw discussion embeddings are bounded and search/neighbor result limits never exceed eighty', () => local(async directory => {
  const data = { records: Array.from({ length: 100 }, (_, index) => record(`raw-${index}`, 'hn', null, { text: `Shared discussion node ${index}. ${'Long context '.repeat(200)}` })), signals: [] };
  const embed = fakeEmbed(() => [1, 0]), index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const result = await index.search('shared discussion', { limit: 999 });
  assert.equal(result.results.length, 80);
  assert.ok(embed.calls[0].texts.every(text => text.length <= 900));
  assert.equal((await index.neighbors('raw-0', { limit: 999 })).results.length, 80);
  assert.equal((await index.search('')).method, 'none');
  assert.deepEqual((await index.neighbors('missing')).results, []);
}));

test('unchanged primitive manifests reuse the exact normalized snapshot, including equivalent corpus replacements', () => {
  let data = corpus(); const current = createNodeSnapshotCache(() => data), first = current();
  assert.strictEqual(current(), first);
  data.fetchedAt = '2026-10-22T22:00:00Z'; data.records[0].fetchedAt = data.fetchedAt;
  assert.strictEqual(current(), first, 'Unrelated timestamps do not normalize/hash every source again');
  data = structuredClone(data);
  assert.strictEqual(current(), first, 'Identity changes without content changes remain warm');
  for (let i = 0; i < 10; i++) assert.strictEqual(current(), first);
});

test('in-place source, analysis, eligibility and group-array edits invalidate the cached manifest', () => {
  const mutations = [
    data => { data.records[0].text += ' New authored context.'; },
    data => { data.records[0].title = 'Changed title'; },
    data => { data.records[0].author = 'ghost'; },
    data => { data.records[0].status = 'removed'; },
    data => { data.records[0].is_opted_out = 'true'; },
    data => { data.records[0].topicId = 'other'; },
    data => { data.records[0].date = '2025-01-01T00:00:00Z'; },
    data => { data.records[0].recordType = 'comment'; },
    data => { data.records[0].problemAnalysis.classification = 'discussion'; },
    data => { data.records[0].problemAnalysis.confidence = .1; },
    data => { data.records[0].problemAnalysis.requesterRole = 'vendor'; },
    data => { data.records[0].problemAnalysis.evidenceQuote = 'Invented quote'; },
    data => { data.records[0].problemAnalysis.workflow = 'Changed customer workflow'; },
    data => { data.records[0].problemAnalysis.problem = 'Changed customer problem'; },
    data => { data.records[0].problemAnalysis.desiredOutcome = 'Changed customer outcome'; },
    data => { data.records[0].reviewDecision = { status: 'excluded' }; },
    data => { data.records[0].labels.push('enhancement'); },
    data => { data.signals[0].sourceIds[0] = 'calendar-hn'; },
    data => { data.signals[0].sourceIds.push('redwood'); },
    data => { data.signals[0].reviewed = false; },
    data => { data.signals[0].audit = { status: 'failed' }; },
    data => { data.signals[0].desiredOutcome = 'Changed group outcome'; },
    data => { data.signals[0].label = 'Changed group label'; },
    data => { data.records.push(record('new')); },
  ];
  for (const mutate of mutations) {
    const data = corpus(); data.records[0].labels = [];
    const current = createNodeSnapshotCache(() => data), first = current();
    mutate(data); const changed = current();
    assert.notStrictEqual(changed, first, String(mutate)); assert.strictEqual(current(), changed);
  }
  const data = corpus(), current = createNodeSnapshotCache(() => data); delete data.records[0].problemAnalysis;
  const legacy = current(); data.records[0].problemAnalysis = null;
  assert.notStrictEqual(current(), legacy, 'Missing analysis and explicit null have different request eligibility');
});

test('a quote removed beyond the preview boundary cannot leave a stale positive node or problem member', () => {
  const data = corpus(), source = data.records[0];
  source.text = `${'Context '.repeat(300)}${source.problemAnalysis.evidenceQuote}`;
  const current = createNodeSnapshotCache(() => data), before = current();
  source.text = 'Context '.repeat(300);
  const after = current();
  assert.notStrictEqual(after, before);
  assert.notEqual(after.nodes.find(node => node.id === source.id).key, before.nodes.find(node => node.id === source.id).key);
  assert.deepEqual(after.nodes.find(node => node.id === 'problem:chat').sourceIds, ['chat-hn']);
});

test('privacy edits during query embedding are checked again before returning warm results', () => local(async directory => {
  const data = corpus(), base = fakeEmbed(() => [1, 0]); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const embed = async (texts, ...args) => { if (texts.length === 1 && texts[0] === 'all nodes') { entered(); await gate; } return base(texts, ...args); };
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  await index.prewarm(); const pending = index.search('all nodes'); await started;
  data.records[0].private = true; release();
  const result = await pending;
  assert.ok(!result.results.some(node => node.id === 'chat-gh' || node.sourceIds.includes('chat-gh')));
  assert.equal(index.info().nodeCount, 5);
}));

test('loading a complete unchanged vector cache does not rewrite it', () => local(async directory => {
  const data = corpus(), embed = fakeEmbed(), first = createNodeSearch({ getCorpus: () => data, directory, embed });
  await first.prewarm(); const path = resolve(directory, 'node-search/vectors.json'), before = await stat(path, { bigint: true });
  const reopened = createNodeSearch({ getCorpus: () => data, directory, embed }); await reopened.prewarm();
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(embed.calls.length, 1);
}));

test('one generic word cannot bypass semantic admission, while exact phrases, full IDs and distinctive keywords remain reachable', () => local(async directory => {
  const data = { records: [
    record('relevant', 'hn', null, { title: 'Earlier assistant conversations', text: 'Search decisions buried in earlier assistant conversations.' }),
    record('generic', 'hn', null, { title: 'General AI tool discussion', text: 'This AI tool is used for current commentary on unrelated topics.' }),
    record('one-word', 'hn', null, { title: 'A history of cabinetry', text: 'Some older cabinets contain hidden compartments.' }),
    record('distinctive', 'hn', null, { title: 'RedwoodDB database', text: 'A guide to RedwoodDB indexing and execution.' }),
  ], signals: [] };
  const embed = fakeEmbed(text => text === 'find older ai chats' || /buried in earlier/i.test(text) ? [1, 0] : [0, 1]);
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const found = await index.search('find older AI chats', { limit: 60 });
  assert.deepEqual(found.results.map(row => row.id), ['relevant']);
  assert.equal((await index.search('RedwoodDB')).results[0].id, 'distinctive');
  assert.ok((await index.search('one-word')).results.some(row => row.id === 'one-word'));
  assert.ok((await index.search('hidden compartments')).results.some(row => row.id === 'one-word'));
  const related = await index.neighbors('relevant');
  assert.deepEqual(related.results, [], 'Lexical overlap cannot admit an orthogonal semantic neighbor');
}));

test('partial lexical admission requires sixty percent meaningful coverage and two terms for multiword queries', () => local(async directory => {
  const data = { records: [
    record('two', 'hn', null, { title: 'Offline PDF tooling', text: 'Search offline PDFs with locally installed command-line utilities.' }),
    record('one', 'hn', null, { title: 'Offline gaming', text: 'A discussion of offline games and local entertainment.' }),
  ], signals: [] };
  const embed = fakeEmbed(text => text === 'offline document search' || text === 'offline software tool' ? [1, 0] : [0, 1]);
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  const partial = await index.search('offline document search');
  assert.deepEqual(partial.results.map(row => row.id), ['two']);
  assert.deepEqual((await index.search('offline software tool')).results, [], 'One meaningful word in a multiword query does not bypass similarity');
}));

test('semantic search can return fewer results when the remaining matches are far below the closest evidence', () => local(async directory => {
  const data = { records: [record('strong', 'hn', null, { title: 'Strong match', text: 'A distinctive source with a matching workflow.' }), record('weak', 'hn', null, { title: 'Weak match', text: 'An unrelated source with only modest vector similarity.' })], signals: [] };
  const embed = fakeEmbed(text => text === 'meaning query' || /strong match/i.test(text) ? [1, 0] : [.5, Math.sqrt(.75)]);
  const index = createNodeSearch({ getCorpus: () => data, directory, embed });
  assert.deepEqual((await index.search('meaning query', { limit: 60 })).results.map(row => row.id), ['strong']);
  assert.ok((await index.neighbors('strong')).results.some(row => row.id === 'weak'), 'Neighbor discovery retains its independent minimum similarity');
}));
