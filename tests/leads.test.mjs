import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AtlasStore, TOPICS, selectedProblemIds, rankLeads, matchIdeaProblems } from '../server/data.mjs';

const NOW = Date.parse('2026-10-22T22:00:00.000Z');
const quote = 'I need failed webhook deliveries to retry automatically so an outage does not lose order events.';
const source = (id, changes = {}) => ({ id, author: `person${id}`, authorId: `github:person${id}`, source: 'github', title: 'Feature: redeliver order notifications', text: quote, url: `https://github.com/example/app/issues/${id}`, profileUrl: `https://github.com/person${id}`, date: '2026-10-22T12:00:00.000Z', status: 'open', topicId: 'integrations', signalId: 'problem:retry', problemAnalysis: { sourceId: id, classification: 'request', requesterRole: 'user', workflow: 'Receive webhook events', problem: 'Failed deliveries lose order events', desiredOutcome: 'Retry failed deliveries automatically', evidenceQuote: quote, confidence: .9 }, ...changes });
const problem = (sourceIds, changes = {}) => ({ id: 'problem:retry', label: 'Retry failed webhook deliveries', audience: 'Developers', workflow: 'Receive webhook events', problem: 'Failed deliveries lose order events', desiredOutcome: 'Retry failed webhook deliveries automatically', sourceIds, reviewed: true, confidence: .9, ...changes });
const atlas = (records, groups = [problem(records.map(record => record.id))]) => ({ topics: TOPICS, records, signals: groups });
const idea = (changes = {}) => ({ title: 'Recover order events', description: 'Prevent transient outages from losing order notifications', sourceIds: ['1'], problemIds: ['problem:retry'], topicId: 'integrations', revision: 2, ...changes });
const temporaryStore = async records => { const directory = await mkdtemp(resolve(tmpdir(), 'atlas-problem-leads-')); const store = new AtlasStore(directory); store.corpus = atlas(records); return { store, directory }; };

test('picked problems retrieve every requester independently of lexical overlap or attached-source cap', () => {
  const records = Array.from({ length: 41 }, (_, index) => source(String(index + 1)));
  const leads = rankLeads(atlas(records), idea({ title: 'Postal rescue', description: 'Recover lost parcels', sourceIds: ['1'] }), undefined, { now: NOW });
  assert.equal(leads.length, 41);
  assert.ok(leads.some(lead => lead.sourceIds.includes('41')));
  for (const lead of leads) {
    assert.equal(lead.kind, 'Requester');
    assert.equal(lead.matchKind, 'selected-problem');
    assert.deepEqual(lead.problemIds, ['problem:retry']);
    assert.equal(lead.evidenceQuote, quote);
    assert.equal(lead.requestEvidence[0].quote, quote);
    assert.equal(lead.ideaRevision, 2);
    assert.ok(!('email' in lead));
  }
});

test('a group member who is a vendor, nonrequest, resolved, removed, synthetic or unknown author is excluded', () => {
  const records = [source('real'), source('vendor', { problemAnalysis: { ...source('vendor').problemAnalysis, requesterRole: 'vendor' } }), source('promotion', { problemAnalysis: { ...source('promotion').problemAnalysis, classification: 'promotion' } }), source('discussion', { problemAnalysis: { ...source('discussion').problemAnalysis, classification: 'discussion' } }), source('closed', { status: 'closed' }), source('resolved', { status: 'resolved' }), source('removed', { status: 'removed' }), source('synthetic', { synthetic: true }), source('anonymous', { authorId: '' }), source('weak', { problemAnalysis: { ...source('weak').problemAnalysis, confidence: .2 } }), source('fakequote', { problemAnalysis: { ...source('fakequote').problemAnalysis, evidenceQuote: 'A different quote which this requester never wrote.' } })];
  const leads = rankLeads(atlas(records), idea({ sourceIds: ['real'] }), undefined, { now: NOW });
  assert.deepEqual(leads.map(lead => lead.id), ['github:personreal']);
});

test('GitHub deleted-account placeholders are context, never attributable requesters or leads', () => {
  const ghost = source('ghost-comment', { author: 'ghost', authorId: 'github:ghost' });
  const real = source('real');
  const leads = rankLeads(atlas([ghost, real]), idea(), undefined, { now: NOW });
  assert.deepEqual(leads.map(lead => lead.id), ['github:personreal']);
});

test('one platform account becomes one lead and the same public name on another platform stays distinct', () => {
  const records = [source('1', { author: 'Alice', authorId: 'github:Alice' }), source('2', { author: 'alice', authorId: 'github:alice' }), source('3', { author: 'alice', authorId: 'reddit:alice', source: 'reddit', url: 'https://www.reddit.com/r/software/comments/abc/request/' })];
  const leads = rankLeads(atlas(records), idea(), undefined, { now: NOW });
  assert.equal(leads.length, 2);
  assert.deepEqual(new Set(leads.find(lead => lead.id === 'github:alice').sourceIds), new Set(['1', '2']));
  assert.equal(leads.find(lead => lead.id === 'github:alice').requestEvidence.length, 2);
  assert.ok(leads.some(lead => lead.id === 'reddit:alice'));
});

test('idea saves validate explicit problem IDs and infer membership before trimming attached sources', async () => {
  const records = Array.from({ length: 31 }, (_, index) => source(String(index + 1)));
  records[30].signalId = 'problem:second';
  const { store, directory } = await temporaryStore(records);
  store.corpus.signals = [problem(records.slice(0, 30).map(record => record.id)), problem(['31'], { id: 'problem:second' }), problem(['1'], { id: 'problem:unreviewed', reviewed: false })];
  try {
    await store.setIdea({ title: 'Recover events', sourceIds: records.map(record => record.id), problemIds: ['problem:retry', 'invented', 'problem:unreviewed', 'problem:retry'] });
    assert.equal(store.state.idea.sourceIds.length, 30);
    assert.deepEqual(store.state.idea.problemIds, ['problem:retry', 'problem:second']);
    const saved = JSON.parse(await readFile(resolve(directory, 'state.json'), 'utf8'));
    assert.deepEqual(saved.idea.problemIds, ['problem:retry', 'problem:second']);
    assert.deepEqual(selectedProblemIds(store.corpus, { sourceIds: ['1'], problemIds: ['invented'] }), ['problem:retry']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('custom ideas match normalized problem descriptions with local embeddings and a real similarity cutoff', async () => {
  const records = [source('1'), source('2', { signalId: 'problem:calendar' })];
  const corpus = atlas(records, [problem(['1']), problem(['2'], { id: 'problem:calendar', label: 'Share calendar availability', workflow: 'Schedule customer meetings', problem: 'Calendar sharing exposes private appointments', desiredOutcome: 'Share free meeting slots without revealing event titles' })]);
  let observed;
  const matches = await matchIdeaProblems(corpus, idea({ sourceIds: [], problemIds: [] }), '/unused', { embed: async texts => { observed = texts; return [[1, 0], [.8, .6], [0, 1]]; } });
  assert.deepEqual(matches, [{ problemId: 'problem:retry', similarity: .8, matchKind: 'semantic-problem' }]);
  assert.match(observed[1], /Receive webhook events.*Failed deliveries lose order events.*Desired outcome:/);
  const leads = rankLeads(corpus, idea({ sourceIds: [], problemIds: [] }), undefined, { problemMatches: matches, now: NOW });
  assert.deepEqual(leads.map(lead => lead.id), ['github:person1']);
  assert.equal(leads[0].matchKind, 'semantic-problem');
  assert.equal(leads[0].matchScore, .8);
  await assert.rejects(matchIdeaProblems(corpus, idea(), '/unused', { embed: async () => [[1, 0]] }), /invalid vectors/);
});

test('custom idea semantic failure exposes keyword fallback and analyzed discussion never becomes a requester', async () => {
  const records = [source('1'), source('2', { problemAnalysis: { ...source('2').problemAnalysis, classification: 'discussion' } })];
  const { store, directory } = await temporaryStore(records);
  try {
    await store.setIdea({ title: 'Retry webhook deliveries', sourceIds: [], problemIds: [] });
    const leads = await store.findLeads({ embed: async () => { throw new Error('Model is unavailable offline'); } });
    assert.deepEqual(leads.map(lead => lead.id), ['github:person1']);
    assert.equal(leads[0].matchKind, 'keyword-request');
    assert.equal(store.state.leadSearch.method, 'keyword-request');
    assert.equal(store.state.leadSearch.status, 'embedding-unavailable');
    assert.match(store.state.leadSearch.error, /offline/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exact groups skip semantic calls and report total requesters when the graph shows the first 100', async () => {
  const records = Array.from({ length: 106 }, (_, index) => source(String(index + 1)));
  const { store, directory } = await temporaryStore(records);
  try {
    await store.setIdea({ title: 'Recover events', sourceIds: [], problemIds: ['problem:retry'] });
    const leads = await store.findLeads({ embed: async () => { throw new Error('Exact matching must not call embeddings'); } });
    assert.equal(leads.length, 100);
    assert.equal(store.state.leadSearch.totalMatches, 106);
    assert.equal(store.state.leadSearch.displayedCount, 100);
    assert.equal(store.state.leadSearch.method, 'selected-problem');
    assert.equal(store.state.leadSearch.status, 'matched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an idea edit during semantic matching cannot overwrite leads for the new revision', async () => {
  const { store, directory } = await temporaryStore([source('1')]);
  try {
    await store.setIdea({ title: 'Retry webhook deliveries', sourceIds: [], problemIds: [] });
    let finish;
    const pending = store.findLeads({ embed: () => new Promise(resolve => { finish = resolve; }) });
    await store.setIdea({ title: 'A different idea', sourceIds: [], problemIds: [] });
    finish([[1, 0], [1, 0]]);
    await assert.rejects(pending, /idea or atlas changed/);
    assert.equal(store.state.idea.title, 'A different idea');
    assert.deepEqual(store.state.leads, []);
    assert.equal(store.state.leadSearch, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
