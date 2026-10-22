import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeCorpus, recountSignals, requestRecords } from '../server/signals.mjs';
import { rankLeads, TOPICS } from '../server/data.mjs';
import { requestFor } from '../server/requests.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA } from '../server/problems.mjs';
import { AUDIT_SCHEMA } from '../server/audit.mjs';

const meanings = [
  { workflow: 'Receive order webhook events', problem: 'Transient receiver outages lose order events', desiredOutcome: 'Retry failed order webhook deliveries automatically', quote: 'I need failed order webhook deliveries to retry when the receiving service recovers from an outage.' },
  { workflow: 'Recover failed order callback deliveries', problem: 'Receiver downtime drops order callback notifications', desiredOutcome: 'Redeliver failed order callbacks after the receiver recovers', quote: 'I need a tool to redeliver order callbacks that failed while our receiving service was down.' },
  { workflow: 'Handle failed order notification delivery', problem: 'Temporary endpoint downtime loses order notifications', desiredOutcome: 'Resend failed order notifications when the endpoint is available', quote: 'I need failed order webhook notifications sent again once the receiving endpoint comes back online.' },
];
const source = (id, family = 0, changes = {}) => ({ id, family, source: 'github', title: `Feature request: ${meanings[family].desiredOutcome}`, text: meanings[family].quote, author: `person${id}`, authorId: `github:person${id}`, url: `https://github.com/example/app/issues/${id}`, date: new Date(Date.now() - 86400000).toISOString(), status: 'open', recordType: 'post', topicId: 'integrations', ...changes });
const row = record => ({ sourceId: record.id, classification: 'request', requesterRole: 'user', audience: 'Developers', workflow: meanings[record.family].workflow, problem: meanings[record.family].problem, desiredOutcome: meanings[record.family].desiredOutcome, evidenceQuote: record.text, confidence: .95, proposedProblemKey: null });
const group = (candidateIds, sourceIds, family = 0) => ({ candidateIds, sourceIds, label: meanings[family].desiredOutcome, audience: 'Developers', workflow: meanings[family].workflow, problem: meanings[family].problem, desiredOutcome: meanings[family].desiredOutcome, confidence: .94, coherence: 'coherent' });
const data = prompt => JSON.parse(prompt.split('SOURCE_DATA = ')[1]);
const candidates = prompt => JSON.parse(prompt.split('CANDIDATES = ')[1].split('\nREQUEST_DATA = ')[0]);
function model(records, review, audit = () => { throw new Error('Unexpected audit'); }) {
  const byId = new Map(records.map(record => [record.id, record]));
  return { calls: [], async complete(prompt, schema) {
    this.calls.push({ prompt, schema });
    if (schema === EXTRACTION_SCHEMA) return { extractions: data(prompt).map(input => row(byId.get(input.sourceId))) };
    if (schema === GROUP_REVIEW_SCHEMA) return review(candidates(prompt), this.calls.filter(call => call.schema === GROUP_REVIEW_SCHEMA).length);
    assert.equal(schema, AUDIT_SCHEMA); return audit(data(prompt));
  } };
}
async function indexed(records, reasoner, embed) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-final-index-'));
  try { return await analyzeCorpus({ records, topics: TOPICS, status: [], fetchedAt: new Date().toISOString() }, directory, () => {}, { reasoner, embed, concurrency: 1 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a validated review exclusion cannot reappear in request counts or custom-idea keyword leads', async () => {
  const records = [source('a1'), source('b2', 0, { text: 'I need reliable order webhooks, said a hypothetical customer in this software tutorial example.' })];
  const reasoner = model(records, input => ({ groups: [group([input[0].id], ['a1'])], excluded: [{ sourceId: 'b2', reason: 'The author quotes a hypothetical customer rather than stating their own unmet request.' }] }));
  const corpus = await indexed(records, reasoner, async texts => texts.map(() => [1, 0]));
  const excluded = corpus.records.find(record => record.id === 'b2');
  assert.equal(excluded.problemAnalysis.classification, 'request');
  assert.equal(excluded.reviewDecision.status, 'excluded');
  assert.match(excluded.reviewDecision.reason, /hypothetical/);
  assert.equal(excluded.request, null); assert.equal(requestFor(excluded), null);
  assert.equal(excluded.signalId, null);
  assert.equal(corpus.analysis.requestCount, 1);
  assert.equal(corpus.analysis.distinctAuthors, 1);
  assert.equal(requestRecords(corpus.records).length, 1);
  const leads = rankLeads(corpus, { title: 'Reliable order webhooks', description: 'Recover failed order events', sourceIds: [], problemIds: [], revision: 1 });
  assert.ok(leads.length > 0);
  assert.ok(leads.every(lead => !lead.sourceIds.includes('b2')));
  assert.equal(recountSignals(corpus).analysis.requestCount, 1);
});

test('review exclusions are reset before a new analysis instead of suppressing a newly validated request', async () => {
  const record = source('a1', 0, { reviewDecision: { status: 'excluded', reason: 'An older review excluded this source' } });
  const reasoner = model([record], () => { throw new Error('A singleton should not need another grouping review'); });
  const corpus = await indexed([record], reasoner, async texts => texts.map(() => [1, 0]));
  assert.equal(corpus.records[0].reviewDecision, null);
  assert.ok(corpus.records[0].request);
  assert.equal(corpus.analysis.requestCount, 1);
  assert.equal(corpus.signals.length, 1);
});

test('consolidation IDs merge with unrevisited problems before auditing the combined ten-plus demand', async () => {
  const records = Array.from({ length: 12 }, (_, index) => source(`${['a', 'b', 'c'][Math.floor(index / 4)]}${index % 4 + 1}`, Math.floor(index / 4)));
  const reasoner = model(records, (input, pass) => {
    if (pass === 1) {
      assert.equal(input.length, 3);
      return { groups: input.map(candidate => group([candidate.id], candidate.sourceIds, records.find(record => record.id === candidate.sourceIds[0]).family)), excluded: [] };
    }
    assert.equal(input.length, 1);
    assert.equal(input[0].sourceIds.length, 8);
    assert.ok(input[0].sourceIds.every(id => !id.startsWith('a')));
    // The new canonical description is identical to the unrevisited first group.
    return { groups: [group([input[0].id], input[0].sourceIds, 0)], excluded: [] };
  }, input => ({ matches: input.map(record => ({ sourceId: record.sourceId, sameProblem: true, confidence: .95, reason: 'Own explicit request supports retrying failed order deliveries.' })) }));
  let phase = 0;
  const corpus = await indexed(records, reasoner, async texts => {
    phase++;
    if (phase === 1) return texts.map((_text, index) => Array.from({ length: 3 }, (_, coordinate) => Number(Math.floor(index / 4) === coordinate)));
    assert.equal(texts.length, 3);
    return texts.map(text => text.startsWith(meanings[0].workflow) ? [0, 1] : [1, 0]);
  });
  assert.equal(corpus.signals.length, 1);
  assert.equal(new Set(corpus.signals.map(signal => signal.id)).size, corpus.signals.length);
  assert.equal(corpus.signals[0].sourceIds.length, 12);
  assert.equal(corpus.signals[0].requesterCount, 12);
  assert.equal(corpus.signals[0].tier.id, 'recurring');
  assert.equal(corpus.signals[0].audit.inputCount, 12);
  assert.equal(reasoner.calls.filter(call => call.schema === AUDIT_SCHEMA).length, 1);
  assert.equal(data(reasoner.calls.find(call => call.schema === AUDIT_SCHEMA).prompt).length, 12);
});
