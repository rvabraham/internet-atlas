import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryVisibility } from '../shared/graph-visibility.mjs';

const record = (id, authorId, topicId = 'ai', source = 'hn', extra = {}) => ({ id, authorId, topicId, source, author: authorId, title: id, text: 'A real request', ...extra });
const corpus = {
  topics: [{ id: 'ai' }, { id: 'ops' }],
  records: [record('chat-search', 'alice'), record('chat-export', 'alice'), record('other-search', 'bob'), record('webhook', 'carol', 'ops', 'reddit'), record('closed-search', 'dan', 'ai', 'hn', { status: 'closed' })],
  signals: [
    { id: 'search-group', label: 'Search AI chat history', sourceIds: ['chat-search', 'other-search', 'closed-search'] },
    { id: 'export-group', label: 'Export AI chats', sourceIds: ['chat-export'] },
    { id: 'webhook-group', label: 'Replay webhooks', sourceIds: ['webhook'] },
  ],
};
const options = extra => ({ corpus, sourceFilters: ['hn', 'reddit'], ...extra });

test('selecting a problem shows its evidence and relevant hubs without unrelated author posts', () => {
  const view = discoveryVisibility(options({ selected: 'search-group' }));
  assert.equal(view.focused, true);
  assert.deepEqual([...view.sourceIds].sort(), ['chat-search', 'closed-search', 'other-search']);
  assert.deepEqual([...view.visibleIds].sort(), ['ai', 'alice', 'bob', 'chat-search', 'closed-search', 'dan', 'other-search', 'search-group']);
  assert.equal(view.topicCounts.get('ai'), 3);
});

test('search results expand matched groups but do not traverse authors into unrelated posts', () => {
  const view = discoveryVisibility(options({ query: 'old AI chats', searchNodeIds: ['search-group', 'webhook'] }));
  assert.equal(view.sourceIds.size, 4);
  assert.equal(view.visibleIds.has('webhook-group'), true);
  assert.equal(view.visibleIds.has('chat-export'), false);
  assert.equal(view.visibleIds.has('export-group'), false);
  const empty = discoveryVisibility(options({ query: 'no match', searchNodeIds: [] }));
  assert.equal(empty.focused, true);
  assert.equal(empty.visibleIds.size, 0);
});

test('related evidence and complete citations stay visible with their hubs across filters', () => {
  const view = discoveryVisibility(options({ selected: 'chat-search', relatedIds: ['export-group'], referencedIds: ['webhook'], sourceFilters: ['hn'] }));
  assert.deepEqual([...view.sourceIds].sort(), ['chat-export', 'chat-search', 'webhook']);
  for (const id of ['ai', 'ops', 'alice', 'carol', 'export-group', 'webhook-group']) assert.equal(view.visibleIds.has(id), true, id);
  const cohort = discoveryVisibility(options({ selected: 'chat-export', referencedIds: ['search-group'] }));
  assert.equal(cohort.sourceIds.size, 4);
});

test('clearing context restores the complete filtered atlas without mutating its sources', () => {
  const before = structuredClone(corpus);
  discoveryVisibility(options({ selected: 'search-group' }));
  const full = discoveryVisibility(options({}));
  assert.equal(full.focused, false);
  assert.equal(full.sourceIds.size, corpus.records.length);
  assert.equal(full.visibleIds.has('export-group'), true);
  const filtered = discoveryVisibility(options({ topicId: 'ops', sourceFilters: ['reddit'] }));
  assert.deepEqual([...filtered.sourceIds], ['webhook']);
  assert.equal(filtered.visibleIds.has('ai'), false);
  assert.deepEqual(corpus, before);
});

test('saved groups and source selection focus their own evidence, live pulses reveal only their source', () => {
  const saved = discoveryVisibility(options({ selected: 'saved-problem', shortlists: [{ problemId: 'saved-problem', label: 'A saved need', sourceIds: ['chat-export'] }] }));
  assert.deepEqual([...saved.sourceIds], ['chat-export']);
  const reading = discoveryVisibility(options({ selected: 'chat-search', pulseIds: ['webhook'] }));
  assert.deepEqual([...reading.sourceIds], ['chat-search', 'webhook']);
  const afterPulse = discoveryVisibility(options({ selected: 'chat-search' }));
  assert.deepEqual([...afterPulse.sourceIds], ['chat-search']);
});

test('withheld sources never return through citations, related groups or stale search IDs', () => {
  const hiddenCorpus = structuredClone(corpus);
  hiddenCorpus.records.find(source => source.id === 'chat-search').opted_out = true;
  const view = discoveryVisibility(options({ corpus: hiddenCorpus, selected: 'search-group', referencedIds: ['chat-search'], pulseIds: ['chat-search'], relatedIds: ['export-group'] }));
  assert.equal(view.visibleIds.has('chat-search'), false);
  assert.equal(view.visibleIds.has('closed-search'), true);
});
