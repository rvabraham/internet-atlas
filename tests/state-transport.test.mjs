import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AtlasStore } from '../server/data.mjs';
import { browserCorpus, createStateBroadcaster, createStateReceiver } from '../shared/state-transport.mjs';
import { sourceVisible } from '../shared/source-visibility.mjs';

const corpus = () => ({ records: [{ id: 'hn:1', text: 'I need searchable agent history.', originalHtml: '<p>I need searchable agent history.</p>', request: { quote: 'I need searchable agent history.' }, dataset: { name: 'Public archive', url: 'https://example.com/posts', license: 'CC BY 4.0' } }], topics: [], signals: [{ id: 'problem:history', sourceIds: ['hn:1'] }], membershipAudits: [{ sourceId: 'hn:1', reason: 'Full per-member diagnostics' }], fetchedAt: '2026-10-22T12:00:00Z' });

test('browser payload removes raw markup and audit diagnostics while preserving source evidence and server originals', () => {
  const original = corpus(), visible = browserCorpus(original);
  assert.ok(!Object.hasOwn(visible, 'membershipAudits'));
  assert.ok(!Object.hasOwn(visible.records[0], 'originalHtml'));
  assert.equal(visible.records[0].text, original.records[0].text);
  assert.deepEqual(visible.records[0].request, original.records[0].request);
  assert.deepEqual(visible.records[0].dataset, original.records[0].dataset);
  assert.equal(original.records[0].originalHtml, '<p>I need searchable agent history.</p>');
  assert.equal(original.membershipAudits.length, 1);
  assert.equal(browserCorpus(original), visible);
  assert.notEqual(browserCorpus({ ...original }), visible);
});

test('unchanged corpus state broadcasts are small patches and replacing the corpus sends a full update once', () => {
  const original = corpus(), encode = createStateBroadcaster(original);
  const state = { corpus: browserCorpus(original), shortlists: [], drafts: {}, messages: [] };
  const bookmark = encode({ ...state, shortlists: [{ problemId: 'problem:history' }] }, original);
  assert.ok(!Object.hasOwn(bookmark, 'corpus'));
  assert.equal(bookmark.shortlists.length, 1);
  const next = { ...original, records: [...original.records, { id: 'hn:2', text: 'A new request', originalHtml: '<p>A new request</p>' }] };
  const replaced = encode({ ...state, corpus: browserCorpus(next) }, next);
  assert.equal(replaced.corpus.records.length, 2);
  assert.ok(!Object.hasOwn(replaced.corpus.records[1], 'originalHtml'));
  assert.ok(!Object.hasOwn(encode({ ...state, corpus: browserCorpus(next), drafts: { one: 'new draft' } }, next), 'corpus'));
});

test('full GET state always retains the sanitized corpus regardless of preceding broadcasts', () => {
  const store = new AtlasStore('/unused'); store.corpus = corpus();
  const encode = createStateBroadcaster(store.corpus);
  assert.ok(!Object.hasOwn(encode(store.publicState(), store.corpus), 'corpus'));
  const first = store.publicState(), next = store.publicState();
  assert.equal(first.corpus.records[0].text, store.corpus.records[0].text);
  assert.equal(next.corpus, first.corpus);
  assert.ok(!Object.hasOwn(first.corpus.records[0], 'originalHtml'));
  assert.equal(store.source('hn:1').originalHtml, '<p>I need searchable agent history.</p>');
});

test('partial SSE updates arriving before initial GET are buffered and preserve the full corpus', () => {
  const receive = createStateReceiver(), evidence = browserCorpus(corpus());
  assert.equal(receive.receive({ shortlists: [{ problemId: 'new' }], drafts: { new: 'saved' } }), null);
  const loaded = receive.initialize({ corpus: evidence, shortlists: [], drafts: {}, messages: ['old'] });
  assert.equal(loaded.corpus, evidence);
  assert.deepEqual(loaded.shortlists, [{ problemId: 'new' }]);
  assert.deepEqual(loaded.drafts, { new: 'saved' });
  const patch = receive.receive({ messages: ['latest'], shortlists: [] });
  assert.equal(patch.corpus, evidence);
  assert.deepEqual(patch.shortlists, []);
});

test('a full SSE bootstrap or reconnect supersedes an older GET and recovers missed corpus changes', () => {
  const receive = createStateReceiver(), older = browserCorpus(corpus());
  const newer = browserCorpus({ ...corpus(), fetchedAt: '2026-10-22T13:00:00Z', records: [{ id: 'hn:2', text: 'Newly collected evidence' }] });
  receive.receive({ corpus: newer, shortlists: [{ problemId: 'new' }], messages: ['newer'] });
  const state = receive.initialize({ corpus: older, shortlists: [], messages: ['older'] });
  assert.equal(state.corpus, newer);
  assert.deepEqual(state.messages, ['newer']);
  assert.equal(receive.receive({ drafts: { one: 'saved' } }).corpus, newer);
});

test('null GitHub profile fields remain null for tools and old literal null cache values are hidden in browser state', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-profile-null-'));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ name: 'Alex', bio: null, company: null, email: null, blog: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  try {
    const store = new AtlasStore(directory);
    store.state.leads = [{ id: 'github:alex', name: 'alex', source: 'github', sourceIds: [], profileUrl: 'https://github.com/alex' }];
    const profile = await store.researchLead('github:alex');
    assert.equal(profile.company, null);
    assert.equal(profile.bio, null);
    assert.equal(store.state.profiles['github:alex'].company, null);
    store.state.profiles.cached = { name: 'cached', bio: 'null', company: 'null' };
    const visible = store.publicState();
    assert.equal(visible.profiles.cached.bio, null);
    assert.equal(visible.profiles.cached.company, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('withheld source bodies and inaccessible groups never enter browser payloads, while closed public context remains navigable', () => {
  const publicRecord = { ...corpus().records[0], id: 'public', author: 'public-author', status: 'public' };
  const closed = { ...publicRecord, id: 'closed', status: 'closed', text: 'A closed public issue remains useful context.' };
  const resolved = { ...publicRecord, id: 'resolved', status: 'resolved', text: 'A resolved public issue remains useful context.' };
  const hidden = ['private', 'removed', 'deleted', 'withdrawn', 'opted_out', 'redacted', 'unavailable'].map((status, index) => ({ ...publicRecord, id: `hidden${index}`, status, text: `Withheld secret body ${index}`, title: `Withheld secret title ${index}`, request: { quote: `Withheld secret body ${index}` }, originalHtml: `Withheld secret markup ${index}` }));
  const original = { ...corpus(), records: [publicRecord, closed, resolved, ...hidden], signals: [
    { id: 'mixed', representativeId: hidden[0].id, sourceIds: ['public', hidden[0].id] },
    { id: 'all-hidden', label: 'A withheld group', sourceIds: hidden.map(record => record.id) },
    { id: 'closed-context', sourceIds: ['closed', 'resolved'] },
  ] };
  const before = structuredClone(original), visible = browserCorpus(original);
  assert.deepEqual(visible.records.map(record => record.id), ['public', 'closed', 'resolved']);
  assert.deepEqual(visible.signals.map(group => group.id), ['mixed', 'closed-context']);
  assert.deepEqual(visible.signals[0].sourceIds, ['public']); assert.equal(visible.signals[0].representativeId, 'public');
  assert.deepEqual(visible.signals[1].sourceIds, ['closed', 'resolved']);
  assert.ok(!JSON.stringify(visible).includes('Withheld secret')); assert.ok(!JSON.stringify(visible).includes('all-hidden'));
  assert.deepEqual(original, before);
});

test('shared visibility guard blocks private literal matches for boolean flag forms without excluding closed or resolved context', () => {
  const source = { title: 'Searchable private phrase', text: 'Searchable private phrase in the source body', source: 'hn', topicId: 'agents', status: 'public' };
  const flags = ['private', 'deleted', 'removed', 'opted_out', 'optedOut', 'optOut', 'redacted', 'withdrawn', 'unavailable', 'is_private', 'is_deleted', 'is_removed', 'is_opted_out', 'is_redacted', 'is_withdrawn', 'is_unavailable'];
  const literalMatch = record => sourceVisible(record) && record.source === 'hn' && `${record.title} ${record.text}`.includes('Searchable private phrase');
  assert.equal(literalMatch(source), true);
  for (const flag of flags) {
    for (const value of [true, 1, 'true', 'TRUE', 'yes', '1']) assert.equal(literalMatch({ ...source, [flag]: value }), false, `${flag}:${value}`);
    for (const value of [false, 0, 'false', 'FALSE', 'no', '0']) assert.equal(literalMatch({ ...source, [flag]: value }), true, `${flag}:${value}`);
  }
  for (const status of ['private', 'PRIVATE', 'opted-out', 'opted_out', 'opted out', 'deleted', 'removed', 'withdrawn', 'redacted', 'unavailable']) assert.equal(literalMatch({ ...source, status }), false, status);
  for (const status of ['public', 'open', 'closed', 'resolved']) assert.equal(literalMatch({ ...source, status }), true, status);
});

test('in-place withdrawal invalidates sanitized views and broadcasts a full replacement once despite unchanged raw identity', () => {
  const original = corpus(), first = browserCorpus(original), encode = createStateBroadcaster(original), receive = createStateReceiver();
  const state = { corpus: first, drafts: { saved: 'Keep this draft' }, messages: [] };
  receive.initialize(state);
  assert.ok(!Object.hasOwn(encode(state, original), 'corpus'));
  original.records[0].opted_out = true;
  const hidden = browserCorpus(original);
  assert.notEqual(hidden, first); assert.deepEqual(hidden.records, []); assert.deepEqual(hidden.signals, []);
  // Even a caller holding the previous sanitized payload cannot rebroadcast it.
  const replacement = encode(state, original);
  assert.equal(replacement.corpus, hidden); assert.ok(!JSON.stringify(replacement.corpus).includes('I need searchable agent history.'));
  assert.deepEqual(receive.receive(replacement).corpus.records, []);
  assert.deepEqual(receive.receive(replacement).drafts, state.drafts);
  assert.ok(!Object.hasOwn(encode({ ...state, corpus: hidden, drafts: { saved: 'Edited draft' } }, original), 'corpus'));
  assert.equal(browserCorpus(original), hidden);
  assert.equal(original.records[0].text, 'I need searchable agent history.');
});

test('in-place group membership and public content edits update browser views without serializing the corpus to detect changes', () => {
  const original = corpus();
  original.toJSON = () => { throw new Error('Full-corpus JSON serialization must not be used for invalidation'); };
  const first = browserCorpus(original);
  original.records.push({ id: 'hn:2', text: 'Another public request', status: 'public' });
  original.signals[0].sourceIds.push('hn:2');
  const next = browserCorpus(original);
  assert.notEqual(next, first); assert.deepEqual(next.signals[0].sourceIds, ['hn:1', 'hn:2']);
  original.records[0].text = 'Updated public request text';
  const changed = browserCorpus(original); assert.equal(changed.records[0].text, 'Updated public request text'); assert.strictEqual(browserCorpus(original), changed);
});
