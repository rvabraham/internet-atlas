import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeCorpus, searchSignals } from '../server/signals.mjs';
import { rankLeads, TOPICS } from '../server/data.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA } from '../server/problems.mjs';

const recentDate = () => new Date(Date.now() - 86400000).toISOString();
const request = (id, changes = {}) => ({
  id, source: 'github', author: `person${id.replace(/\W/g, '')}`, authorId: `github:person${id.replace(/\W/g, '')}`,
  title: 'Feature request: retry failed webhooks', text: 'I need failed webhook deliveries to retry automatically so an outage does not lose order events.',
  url: `https://github.com/example/app/issues/${id.replace(/\W/g, '')}`, profileUrl: 'https://github.com/requester',
  topicId: 'integrations', status: 'open', date: recentDate(), fetchedAt: recentDate(), recordType: 'post', origin: 'live-api',
  ...changes,
});
const understanding = (record, changes = {}) => ({
  sourceId: record.id, classification: 'request', requesterRole: 'user', audience: 'Developers',
  workflow: 'Receive webhook events', problem: 'Failed webhook deliveries lose order events',
  desiredOutcome: 'Retry failed webhook deliveries automatically', evidenceQuote: record.text, confidence: .94, proposedProblemKey: null,
  ...changes,
});
const calendarRequest = () => request('hn:calendar', {
  source: 'hn', author: 'calendar-user', authorId: 'hn:calendar-user',
  title: 'Looking for a tool to share calendar availability privately',
  text: 'I need a tool to share available calendar slots with clients without revealing private event titles.',
  url: 'https://news.ycombinator.com/item?id=12345', profileUrl: 'https://news.ycombinator.com/user?id=calendar-user', topicId: 'software', status: 'public',
});
const calendarUnderstanding = record => understanding(record, { audience: 'Calendar users', workflow: 'Share calendar availability', problem: 'Sharing calendars exposes private event titles', desiredOutcome: 'Share available slots without exposing private event titles' });
const candidateData = prompt => JSON.parse(prompt.split('CANDIDATES = ')[1].split('\nREQUEST_DATA = ')[0]);
const groupFor = (candidateIds, rows, changes = {}) => ({
  candidateIds, label: rows[0].desiredOutcome, audience: rows[0].audience, workflow: rows[0].workflow,
  problem: rows[0].problem, desiredOutcome: rows[0].desiredOutcome,
  sourceIds: rows.map(row => row.sourceId), confidence: .93, coherence: 'coherent', ...changes,
});

function fakeReasoner(rows, onReview = () => { throw new Error('Singletons must not be sent for grouping review'); }) {
  const byId = new Map(rows.map(row => [row.sourceId, row]));
  const calls = [];
  return {
    calls,
    async complete(prompt, schema) {
      calls.push({ prompt, schema });
      if (schema === EXTRACTION_SCHEMA) {
        const inputs = JSON.parse(prompt.split('SOURCE_DATA = ')[1]);
        return { extractions: inputs.map(input => byId.get(input.sourceId)) };
      }
      assert.equal(schema, GROUP_REVIEW_SCHEMA);
      return onReview(candidateData(prompt), prompt);
    },
  };
}

async function indexed(records, rows, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-problem-index-'));
  try {
    const reasoner = options.reasoner || fakeReasoner(rows);
    const corpus = await analyzeCorpus({ topics: TOPICS, records, fetchedAt: recentDate() }, directory, () => {}, { reasoner, embed: async texts => texts.map((_, index) => Array.from({ length: texts.length }, (_item, coordinate) => Number(index === coordinate))), batchSize: 20, concurrency: 1, ...options });
    return { corpus, calls: reasoner.calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a valid unmatched singleton is indexed without a second model decision and stays searchable and usable as a lead', async () => {
  const webhook = request('gh:webhook'), calendar = calendarRequest();
  const rows = [understanding(webhook), calendarUnderstanding(calendar)];
  const { corpus, calls } = await indexed([webhook, calendar], rows);
  assert.equal(calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length, 0);
  assert.equal(corpus.signals.length, 2);
  assert.equal(corpus.analysis.requestCount, 2);
  assert.equal(corpus.analysis.groupedRequestCount, 2);
  for (const [query, platform, sourceId] of [['webhook', 'github', webhook.id], ['calendar', 'hn', calendar.id]]) {
    const groups = searchSignals(corpus, query);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].sourceIds, [sourceId]);
    assert.equal(groups[0].requesterCount, 1);
    assert.equal(groups[0].allTimeCount, 1);
    assert.match(groups[0].reviewMethod, /single-request/);
    assert.equal(corpus.records.find(record => record.id === sourceId).signalId, groups[0].id);
    const leads = rankLeads(corpus, { title: groups[0].label, sourceIds: [], problemIds: [groups[0].id], revision: 1 });
    assert.equal(leads.length, 1);
    assert.equal(leads[0].source, platform);
    assert.equal(leads[0].matchKind, 'selected-problem');
    assert.equal(leads[0].evidenceQuote, corpus.records.find(record => record.id === sourceId).text);
  }
});

test('historical singleton demand remains indexed and searchable while its recent requester count is zero', async () => {
  const old = request('gh:archive', { date: new Date(Date.now() - 367 * 86400000).toISOString(), origin: 'dataset' });
  const { corpus, calls } = await indexed([old], [understanding(old)]);
  assert.equal(calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length, 0);
  const [group] = searchSignals(corpus, 'webhook');
  assert.ok(group);
  assert.equal(group.allTimeCount, 1);
  assert.equal(group.requesterCount, 0);
  assert.equal(group.tier.id, 'early');
  assert.equal(group.windowDays, 365);
  assert.deepEqual(group.sourceIds, [old.id]);
  assert.equal(corpus.records[0].signalId, group.id);
  const leads = rankLeads(corpus, { title: group.label, sourceIds: [], problemIds: [group.id], revision: 1 });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].requestEvidence[0].date, old.date);
});

test('a coarse candidate containing unrelated asks is split by review into separate user problems', async () => {
  const webhook = request('gh:webhook'), calendar = calendarRequest();
  const rows = [understanding(webhook), calendarUnderstanding(calendar)];
  const reasoner = fakeReasoner(rows, candidates => {
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceIds.length, 2);
    return { groups: rows.map(row => groupFor([candidates[0].id], [row])), excluded: [] };
  });
  const { corpus, calls } = await indexed([webhook, calendar], rows, { reasoner, embed: async texts => texts.map(() => [1, 0]) });
  assert.equal(calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length, 2, 'the cross-batch consolidation also preserves separate needs');
  assert.equal(corpus.signals.length, 2);
  assert.ok(corpus.signals.every(group => group.requesterCount === 1 && group.allTimeCount === 1));
  assert.deepEqual(new Set(corpus.signals.flatMap(group => group.sourceIds)), new Set([webhook.id, calendar.id]));
  assert.notEqual(corpus.records[0].signalId, corpus.records[1].signalId);
});

test('model-rejected requests never reappear through the old explicit-ask detector', async () => {
  const real = request('gh:real'), vendor = request('gh:vendor', { text: 'I need our new webhook automation product added to your software directory. Please list our app.' });
  const rows = [understanding(real), understanding(vendor, { classification: 'promotion', requesterRole: 'vendor', audience: '', workflow: '', problem: '', desiredOutcome: '' })];
  const { corpus } = await indexed([real, vendor], rows);
  assert.equal(corpus.analysis.requestCount, 1);
  assert.equal(corpus.analysis.groupedRequestCount, 1);
  assert.equal(corpus.records.find(record => record.id === vendor.id).problemAnalysis.classification, 'promotion');
  assert.equal(corpus.records.find(record => record.id === vendor.id).request, null);
  assert.equal(corpus.records.find(record => record.id === vendor.id).signalId, null);
  assert.ok(corpus.signals.every(group => !group.sourceIds.includes(vendor.id)));
  const leads = rankLeads(corpus, { title: 'Webhook automation', description: 'Software directory', sourceIds: [], problemIds: [], revision: 1 });
  assert.ok(leads.every(lead => !lead.sourceIds.includes(vendor.id)));
});

test('review cannot invent demand counts and accepted counts come from distinct source accounts', async () => {
  const first = request('gh:one', { author: 'Alice', authorId: 'github:Alice' }), second = request('gh:two', { author: 'alice', authorId: 'github:alice' });
  const rows = [understanding(first), understanding(second)];
  const makeOptions = inventedCount => ({ embed: async texts => texts.map(() => [1, 0]), reasoner: fakeReasoner(rows, candidates => ({ groups: [groupFor([candidates[0].id], rows, inventedCount ? { requesterCount: 50 } : {})], excluded: [] })) });
  const invented = await indexed([first, second], rows, makeOptions(true));
  assert.equal(invented.corpus.signals.length, 2, 'invalid grouping preserves validated asks as separate singletons');
  assert.ok(invented.corpus.signals.every(group => group.requesterCount === 1 && group.tier.id === 'early'));
  assert.ok(invented.corpus.analysis.validationRejects > 0);
  const valid = await indexed([first, second], rows, makeOptions(false));
  assert.equal(valid.corpus.signals.length, 1);
  assert.equal(valid.corpus.signals[0].requesterCount, 1);
  assert.equal(valid.corpus.signals[0].allTimeCount, 1);
  assert.equal(valid.corpus.signals[0].tier.id, 'early');
  assert.deepEqual(new Set(valid.corpus.signals[0].sourceIds), new Set([first.id, second.id]));
});
