import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeCorpus } from '../server/signals.mjs';
import { TOPICS, rankLeads } from '../server/data.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA } from '../server/problems.mjs';
import { AUDIT_SCHEMA } from '../server/audit.mjs';

const meanings = {
  retry: { workflow: 'Receive order webhook events', problem: 'Transient receiver outages lose order events', desiredOutcome: 'Retry failed webhook deliveries after the receiver recovers', quote: 'I need failed order webhook deliveries to retry when the receiving service recovers from an outage.' },
  recovery: { workflow: 'Recover order callback deliveries', problem: 'Receiver downtime drops order callbacks', desiredOutcome: 'Redeliver order callbacks after the receiving service recovers', quote: 'I need a tool to redeliver order callbacks that failed while our receiving service was down.' },
  calendar: { workflow: 'Share calendar availability', problem: 'Calendar sharing exposes private event titles', desiredOutcome: 'Share available calendar slots without exposing private event titles', quote: 'I need a tool to share available calendar slots with clients without revealing private event titles.' },
  dedup: { workflow: 'Process incoming order webhooks', problem: 'Duplicate successful webhook events charge orders twice', desiredOutcome: 'Ignore duplicate successful order webhook deliveries', quote: 'I need duplicate successful order webhook events ignored so a single order is not charged twice.' },
};
const source = (id, family = 'retry', changes = {}) => ({
  id, source: 'github', author: `person${id}`, authorId: `github:person${id}`,
  title: `Feature request: ${meanings[family].desiredOutcome}`, text: meanings[family].quote,
  url: `https://github.com/example/app/issues/${id}`, profileUrl: `https://github.com/person${id}`,
  date: new Date(Date.now() - 86400000).toISOString(), fetchedAt: new Date().toISOString(),
  status: 'open', topicId: family === 'calendar' ? 'software' : 'integrations', recordType: 'post', family, ...changes,
});
const extraction = record => ({ sourceId: record.id, classification: 'request', audience: 'Developers', workflow: meanings[record.family].workflow, problem: meanings[record.family].problem, desiredOutcome: meanings[record.family].desiredOutcome, evidenceQuote: record.text, confidence: .95, requesterRole: 'user', proposedProblemKey: null });
const group = (candidateIds, sourceIds, family = 'retry', changes = {}) => ({ candidateIds, sourceIds, label: meanings[family].desiredOutcome, audience: 'Developers', workflow: meanings[family].workflow, problem: meanings[family].problem, desiredOutcome: meanings[family].desiredOutcome, confidence: .94, coherence: 'coherent', ...changes });
const sourceData = prompt => JSON.parse(prompt.split('SOURCE_DATA = ')[1]);
const candidates = prompt => JSON.parse(prompt.split('CANDIDATES = ')[1].split('\nREQUEST_DATA = ')[0]);

function fakeReasoner(records, review, audit) {
  const byId = new Map(records.map(record => [record.id, record]));
  return {
    calls: [],
    async complete(prompt, schema) {
      this.calls.push({ prompt, schema });
      if (schema === EXTRACTION_SCHEMA) return { extractions: sourceData(prompt).map(row => extraction(byId.get(row.sourceId))) };
      if (schema === GROUP_REVIEW_SCHEMA) return review(candidates(prompt), prompt, this.calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length);
      assert.equal(schema, AUDIT_SCHEMA);
      assert.ok(audit, 'An unexpected large-group audit was invoked');
      return audit(sourceData(prompt), prompt);
    },
  };
}

async function run(records, reasoner, embed) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-consolidation-'));
  try {
    return await analyzeCorpus({ topics: TOPICS, status: [], records, fetchedAt: new Date().toISOString() }, directory, () => {}, { reasoner, embed, concurrency: 1, batchSize: 20 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('descriptor review reunites paraphrases across initial groups while retaining unrelated asks separately', async () => {
  const records = [source('a1'), source('a2'), source('b1', 'recovery'), source('b2', 'recovery'), source('c1', 'calendar'), source('c2', 'calendar')];
  let embeddingPhase = 0;
  const model = fakeReasoner(records, (input, _prompt, pass) => {
    if (pass === 1) {
      assert.equal(input.length, 3);
      return { groups: input.map(candidate => group([candidate.id], candidate.sourceIds, records.find(record => record.id === candidate.sourceIds[0]).family)), excluded: [] };
    }
    assert.equal(input.length, 1);
    assert.deepEqual(new Set(input[0].sourceIds), new Set(['a1', 'a2', 'b1', 'b2']));
    return { groups: [group([input[0].id], input[0].sourceIds)], excluded: [] };
  });
  const corpus = await run(records, model, async texts => {
    embeddingPhase++;
    if (embeddingPhase === 1) {
      assert.equal(texts.length, 6);
      return [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]];
    }
    assert.equal(texts.length, 3);
    return texts.map(text => text.includes('calendar') ? [0, 1] : [1, 0]);
  });
  assert.equal(embeddingPhase, 2);
  assert.equal(model.calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length, 2);
  assert.equal(corpus.signals.length, 2);
  const retry = corpus.signals.find(signal => signal.sourceIds.includes('a1'));
  const calendar = corpus.signals.find(signal => signal.sourceIds.includes('c1'));
  assert.deepEqual(new Set(retry.sourceIds), new Set(['a1', 'a2', 'b1', 'b2']));
  assert.deepEqual(new Set(calendar.sourceIds), new Set(['c1', 'c2']));
  assert.equal(retry.requesterCount, 4); assert.equal(calendar.requesterCount, 2);
  assert.equal(corpus.analysis.groupedRequestCount, 6);
  assert.equal(corpus.analysis.requestCount, 6);
});

test('failed, omitted or count-inventing reviews retain validated asks as independent singletons', async () => {
  for (const failure of ['error', 'invented-count', 'omitted']) {
    const records = [source('a1'), source('a2')];
    const model = fakeReasoner(records, input => {
      if (failure === 'error') throw new Error('Grouping model is unavailable');
      if (failure === 'omitted') return { groups: [], excluded: [] };
      return { groups: [group([input[0].id], input[0].sourceIds, 'retry', { requesterCount: 50 })], excluded: [] };
    });
    const corpus = await run(records, model, async texts => texts.map(() => [1, 0]));
    assert.equal(corpus.signals.length, 2, failure);
    assert.ok(corpus.signals.every(signal => signal.sourceIds.length === 1 && signal.requesterCount === 1 && signal.allTimeCount === 1), failure);
    assert.deepEqual(new Set(corpus.signals.flatMap(signal => signal.sourceIds)), new Set(['a1', 'a2']), failure);
    assert.equal(corpus.analysis.groupedRequestCount, 2, failure);
    assert.equal(corpus.analysis.status, 'partial', failure);
    if (failure === 'error') assert.ok(corpus.analysis.errors.some(error => error.includes('unavailable')));
    else assert.ok(corpus.analysis.validationRejects > 0);
  }
});

test('ten-plus audit counts distinct passing accounts and preserves a rejected member as its own problem', async () => {
  const records = Array.from({ length: 11 }, (_, index) => source(`r${String(index + 1).padStart(2, '0')}`));
  records[0].author = 'Alice'; records[0].authorId = 'github:Alice';
  records[1].author = 'alice'; records[1].authorId = 'github:alice';
  records.push(source('z12', 'dedup'));
  const model = fakeReasoner(records,
    input => ({ groups: [group([input[0].id], input[0].sourceIds)], excluded: [] }),
    input => ({ matches: input.map(row => ({ sourceId: row.sourceId, sameProblem: row.sourceId !== 'z12', confidence: .95, reason: row.sourceId === 'z12' ? 'Deduplicating successful events is a different remedy from retrying failed deliveries.' : 'The author explicitly asks to retry failed order deliveries.' })) }),
  );
  const corpus = await run(records, model, async texts => texts.map(() => [1, 0]));
  assert.equal(model.calls.filter(call => call.schema === AUDIT_SCHEMA).length, 1);
  assert.equal(corpus.signals.length, 2);
  const retry = corpus.signals.find(signal => signal.sourceIds.includes('r01'));
  const dedup = corpus.signals.find(signal => signal.sourceIds.includes('z12'));
  assert.equal(retry.sourceIds.length, 11);
  assert.equal(retry.requesterCount, 10);
  assert.equal(retry.allTimeCount, 10);
  assert.equal(retry.tier.id, 'recurring');
  assert.equal(retry.audit.status, 'partial');
  assert.equal(retry.audit.inputCount, 12);
  assert.equal(retry.audit.passedCount, 11);
  assert.equal(retry.audit.distinctAccounts, 10);
  assert.deepEqual(dedup.sourceIds, ['z12']);
  assert.equal(dedup.desiredOutcome, meanings.dedup.desiredOutcome);
  assert.equal(dedup.requesterCount, 1);
  assert.equal(corpus.analysis.groupedRequestCount, 12);
  assert.equal(corpus.records.find(record => record.id === 'z12').signalId, dedup.id);
  const leads = rankLeads(corpus, { title: retry.label, sourceIds: [], problemIds: [retry.id], revision: 1 });
  assert.equal(leads.length, 10);
  assert.ok(leads.every(lead => !lead.sourceIds.includes('z12')));
});
