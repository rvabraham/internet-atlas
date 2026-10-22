import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { shortlistSourceIds, updateShortlists } from '../server/shortlists.mjs';
import { AtlasStore, TOPICS } from '../server/data.mjs';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const group = (id = 'signal:retry', sourceIds = ['gh:1'], changes = {}) => ({ id, label: 'Retry failed webhook deliveries', audience: 'Developers', workflow: 'Receive webhook events', problem: 'Failed deliveries lose order events', desiredOutcome: 'Retry failed deliveries automatically', sourceIds, reviewed: true, requesterCount: 12, allTimeCount: 16, asOf: '2026-10-21T12:00:00.000Z', ...changes });
const corpus = { records: [{ id: 'gh:1' }, { id: 'hn:2' }], signals: [group(), group('signal:calendar', ['hn:2'], { label: 'Share calendar availability privately' })] };

test('multiple saved problems retain evidence and do not mutate pins, ideas or the supplied state', () => {
  const pins = ['unrelated'], idea = { id: 'idea', sourceIds: ['unrelated'] };
  const current = [];
  const first = updateShortlists(current, { problemId: 'signal:retry', saved: true }, corpus, NOW);
  const both = updateShortlists(first, { problemId: 'signal:calendar', saved: true }, corpus, NOW);
  assert.equal(current.length, 0);
  assert.equal(first.length, 1);
  assert.deepEqual(both.map(entry => entry.problemId), ['signal:calendar', 'signal:retry']);
  assert.deepEqual(pins, ['unrelated']); assert.deepEqual(idea.sourceIds, ['unrelated']);
  assert.equal(both[1].savedAt, NOW.toISOString());
  assert.equal(both[1].asOf, corpus.signals[0].asOf);
  assert.equal(both[1].requesterCount, 12);
  assert.equal(both[1].allTimeCount, 16);
  assert.deepEqual(shortlistSourceIds(both), ['hn:2', 'gh:1']);
});

test('explicit save and remove are idempotent, keeping the save date and list order', () => {
  const first = updateShortlists([], { problemId: 'signal:retry', saved: true }, corpus, NOW);
  const both = updateShortlists(first, { problemId: 'signal:calendar', saved: true }, corpus, NOW);
  const later = updateShortlists(both, { problemId: 'signal:retry', saved: true }, corpus, new Date(NOW.getTime() + 86400000));
  assert.equal(later.length, 2);
  assert.equal(later[1].savedAt, NOW.toISOString());
  assert.deepEqual(later.map(entry => entry.problemId), both.map(entry => entry.problemId));
  const removed = updateShortlists(later, { problemId: 'signal:retry', saved: false }, { records: [], signals: [] }, NOW);
  assert.deepEqual(removed.map(entry => entry.problemId), ['signal:calendar']);
  assert.deepEqual(updateShortlists(removed, { problemId: 'signal:retry', saved: false }, corpus, NOW), removed);
});

test('saved snapshots survive missing live groups and keep every original source reference', () => {
  const large = { records: Array.from({ length: 50 }, (_, i) => ({ id: `gh:${i}` })), signals: [group('signal:many', Array.from({ length: 50 }, (_, i) => `gh:${i}`))] };
  const saved = updateShortlists([], { problemId: 'signal:many', saved: true }, large, NOW);
  assert.equal(saved[0].sourceIds.length, 50);
  assert.equal(shortlistSourceIds(saved).length, 50);
  assert.equal(saved[0].label, large.signals[0].label);
  assert.equal(saved[0].problem, large.signals[0].problem);
  assert.equal(saved[0].desiredOutcome, large.signals[0].desiredOutcome);
  const snapshot = JSON.parse(JSON.stringify(saved));
  assert.deepEqual(shortlistSourceIds(snapshot), shortlistSourceIds(saved));
  assert.deepEqual(shortlistSourceIds(null), []);
  assert.deepEqual(shortlistSourceIds([{ problemId: 'signal:old', sourceIds: ['gh:1', null, '', 'gh:1'] }, null]), ['gh:1']);
});

test('invented, unreviewed and evidence-free problems cannot be saved, while invalid references are removed', () => {
  for (const bad of [{ problemId: 'invented', saved: true }, { problemId: '', saved: true }, { problemId: 'signal:retry', saved: 'true' }]) assert.throws(() => updateShortlists([], bad, corpus, NOW));
  for (const changes of [{ reviewed: false }, { sourceIds: ['invented'] }, { sourceIds: [] }, { label: '' }]) assert.throws(() => updateShortlists([], { problemId: 'signal:retry', saved: true }, { ...corpus, signals: [group('signal:retry', ['gh:1'], changes)] }, NOW));
  const clean = updateShortlists([], { problemId: 'signal:retry', saved: true }, { ...corpus, signals: [group('signal:retry', ['gh:1', 'invented', 'gh:1'])] }, NOW);
  assert.deepEqual(clean[0].sourceIds, ['gh:1']);
});

test('new saves are bounded, while removing and updating an existing item still work', () => {
  const current = Array.from({ length: 200 }, (_, i) => ({ problemId: `signal:${i}`, sourceIds: ['gh:1'], savedAt: NOW.toISOString() }));
  assert.throws(() => updateShortlists(current, { problemId: 'signal:retry', saved: true }, corpus, NOW), /limited to 200/);
  assert.equal(updateShortlists(current, { problemId: 'signal:0', saved: false }, corpus, NOW).length, 199);
  const updated = updateShortlists(current, { problemId: 'signal:0', saved: true }, { ...corpus, signals: [group('signal:0')] }, NOW);
  assert.equal(updated.length, 200);
  assert.equal(updated[0].label, 'Retry failed webhook deliveries');
});

test('saving a seed-only problem persists its quotes through reload and a corpus replacement', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-saved-evidence-'));
  const evidence = { id: 'saved-evidence-only', source: 'hn', title: 'Retry failed webhook events', text: 'I need failed webhook deliveries to retry automatically so order events are not lost.', author: 'requester', authorId: 'hn:requester', url: 'https://news.ycombinator.com/item?id=999999991', date: NOW.toISOString(), fetchedAt: NOW.toISOString(), status: 'public', topicId: 'integrations' };
  try {
    const store = new AtlasStore(directory);
    store.corpus = { topics: TOPICS, status: [], records: [evidence], signals: [group('saved-problem-only', [evidence.id])], fetchedAt: '2099-01-01T00:00:00.000Z' };
    await store.saveProblem({ problemId: 'saved-problem-only', saved: true });
    const persisted = JSON.parse(await readFile(resolve(directory, 'corpus.json'), 'utf8'));
    assert.equal(persisted.records[0].text, evidence.text);
    const restored = await new AtlasStore(directory).load();
    assert.equal(restored.state.shortlists[0].problemId, 'saved-problem-only');
    assert.equal(restored.source(evidence.id).text, evidence.text);
    assert.equal(restored.state.idea, null);
    assert.deepEqual(restored.state.pinned, []);
    await restored.setCorpus({ topics: TOPICS, status: [], records: [{ ...evidence, id: 'new-unrelated-source', url: 'https://news.ycombinator.com/item?id=999999992' }], signals: [], fetchedAt: '2099-01-02T00:00:00.000Z' });
    const replaced = await new AtlasStore(directory).load();
    assert.equal(replaced.source(evidence.id).text, evidence.text);
    assert.deepEqual(replaced.state.shortlists[0].sourceIds, [evidence.id]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
