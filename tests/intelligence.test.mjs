import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openIntelligenceCache, understandRequests, reviewProblems, reviewBatches, REASONING_MODEL } from '../server/intelligence.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA, validateExtractions } from '../server/problems.mjs';
import { requestFor } from '../server/requests.mjs';

const source = (id, overrides = {}) => ({
  id, source: 'github', author: `person-${id}`, authorId: `github:person-${id}`,
  title: 'Feature request: retry webhook delivery', text: 'I need a webhook tool that retries failed deliveries until the receiving server accepts the event.',
  url: `https://github.com/example/events/issues/${id}`, date: new Date(Date.now() - 86400000).toISOString(),
  status: 'open', recordType: 'post', labels: ['enhancement'], topicId: 'integrations', ...overrides,
});
const extraction = (record, overrides = {}) => ({
  sourceId: record.id, classification: 'request', audience: 'developers', workflow: 'Deliver webhook events',
  problem: 'Failed webhook deliveries are lost', desiredOutcome: 'Retry failed deliveries until accepted',
  evidenceQuote: record.text, confidence: .92, proposedProblemKey: 'retry-failed-webhook-deliveries', requesterRole: 'user', ...overrides,
});
const group = (sourceIds, candidateIds, overrides = {}) => ({
  candidateIds, sourceIds, label: 'Retry failed webhook deliveries', audience: 'developers', workflow: 'Deliver webhook events',
  problem: 'Failed webhook deliveries are lost', desiredOutcome: 'Retry failed deliveries until accepted', confidence: .92, coherence: 'coherent', ...overrides,
});
const extractionInput = prompt => JSON.parse(prompt.split('SOURCE_DATA = ')[1]);
const reviewInput = prompt => ({
  candidates: JSON.parse(prompt.split('CANDIDATES = ')[1].split('\nREQUEST_DATA = ')[0]),
  requests: JSON.parse(prompt.split('\nREQUEST_DATA = ')[1]),
});
const temporaryCache = async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-intelligence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: await openIntelligenceCache(directory) };
};
const understoodSource = (record, overrides = {}) => ({ ...record, problemAnalysis: validateExtractions({ extractions: [extraction(record, overrides)] }, [record]).accepted[0] });

test('extraction cache survives reopening and invalidates on source text or metadata changes', async t => {
  const { directory, cache } = await temporaryCache(t); let calls = 0;
  const reasoner = { complete: async (prompt, schema) => {
    calls++; assert.equal(schema, EXTRACTION_SCHEMA);
    return { extractions: extractionInput(prompt).map(input => extraction({ id: input.sourceId, text: input.text })) };
  } };
  const record = source('cache');
  let result = await understandRequests({ records: [record] }, cache, reasoner);
  assert.equal(calls, 1); assert.equal(result.requests.length, 1);
  assert.equal(result.records[0].problemAnalysis.model, REASONING_MODEL);
  const reopened = await openIntelligenceCache(directory);
  result = await understandRequests({ records: [record] }, reopened, reasoner);
  assert.equal(calls, 1, 'identical source reuses the persisted extraction');
  assert.equal(result.records[0].request.method, 'problem-understanding');
  const edited = { ...record, text: `${record.text} The tool must retain the original event payload.` };
  await understandRequests({ records: [edited] }, reopened, reasoner);
  assert.equal(calls, 2, 'changed source text requires new understanding');
  await understandRequests({ records: [{ ...edited, labels: ['enhancement', 'priority:high'] }] }, reopened, reasoner);
  assert.equal(calls, 3, 'classification metadata participates in cache identity');
});

test('promotion and other nonrequest classifications override stale heuristic request flags', async t => {
  const { cache } = await temporaryCache(t);
  const classifications = ['promotion', 'advice', 'discussion', 'endorsement', 'resolved'];
  const records = classifications.map(classification => source(classification, { request: { type: 'feature_request', quote: 'stale heuristic request' } }));
  const reasoner = { complete: async prompt => ({ extractions: extractionInput(prompt).map(input => extraction({ id: input.sourceId, text: input.text }, {
    classification: input.sourceId, audience: '', workflow: '', problem: '', desiredOutcome: '', proposedProblemKey: null,
    requesterRole: input.sourceId === 'promotion' ? 'vendor' : 'unknown',
  })) }) };
  const result = await understandRequests({ records }, cache, reasoner);
  assert.equal(result.analyzed, classifications.length); assert.equal(result.requests.length, 0);
  for (const record of result.records) {
    assert.equal(record.request, null, `${record.id} cannot fall back to its old heuristic ask`);
    assert.equal(requestFor(record), null);
  }
  const cached = await understandRequests({ records }, cache, { complete: async () => { throw new Error('cached classifications should be reused'); } });
  assert.ok(cached.records.every(record => record.request === null));
});

test('a nonliteral model quote is rejected and is never cached or returned as understood demand', async t => {
  const { cache } = await temporaryCache(t); const record = source('invalid-quote'); let calls = 0;
  const reasoner = { complete: async () => { calls++; return { extractions: [extraction(record, { evidenceQuote: 'I would pay for an enterprise webhook product with unlimited guaranteed deliveries.' })] }; } };
  const result = await understandRequests({ records: [record] }, cache, reasoner);
  assert.equal(result.requests.length, 0); assert.equal(result.analyzed, 0); assert.equal(result.records[0].problemAnalysis, null);
  assert.ok(result.rejected.some(row => row.reasons.some(reason => /literal contiguous/.test(reason))));
  assert.equal(Object.keys(cache.data.extractions).length, 0);
  await understandRequests({ records: [record] }, cache, reasoner);
  assert.equal(calls, 2, 'invalid output cannot masquerade as a completed cache entry');
});

test('review can merge paraphrases across candidates while splitting a mixed candidate', async t => {
  const { cache } = await temporaryCache(t);
  const a = understoodSource(source('a'));
  const b = understoodSource(source('b', { text: 'I wish a webhook app would retry failed event deliveries until they are accepted.' }));
  const c = understoodSource(source('c', { title: 'Feature request: deduplicate webhooks', text: 'I need a webhook API that suppresses duplicate events so each event is processed only once.' }), {
    workflow: 'Process webhook events', problem: 'Duplicate deliveries cause repeated processing', desiredOutcome: 'Process each event only once', proposedProblemKey: 'deduplicate-webhook-deliveries',
  });
  const candidates = [{ id: 'mixed', sourceIds: ['a', 'c'] }, { id: 'paraphrase', sourceIds: ['b'] }];
  const result = await reviewProblems(candidates, [a, b, c], cache, { complete: async (prompt, schema) => {
    assert.equal(schema, GROUP_REVIEW_SCHEMA); const input = reviewInput(prompt);
    const mixed = input.candidates.find(candidate => candidate.sourceIds.includes('c')).id;
    const paraphrase = input.candidates.find(candidate => candidate.sourceIds.includes('b')).id;
    return { groups: [group(['a', 'b'], [mixed, paraphrase]), group(['c'], [mixed], {
      label: 'Suppress duplicate webhook processing', workflow: 'Process webhook events', problem: 'Duplicate deliveries cause repeated processing', desiredOutcome: 'Process each event only once',
    })], excluded: [] };
  } });
  assert.equal(result.rejected.length, 0); assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(item => item.sourceIds).sort((x, y) => y.length - x.length), [['a', 'b'], ['c']]);
  assert.ok(result.groups.every(item => item.reviewed && item.inferred && item.id.startsWith('signal:')));
});

test('review cache is persisted and invalidates when extracted problem meaning changes', async t => {
  const { directory, cache } = await temporaryCache(t); let calls = 0;
  const record = understoodSource(source('review-cache'));
  const candidates = [{ id: 'candidate', sourceIds: [record.id] }];
  const reasoner = { complete: async prompt => {
    calls++; const input = reviewInput(prompt), request = input.requests[0];
    return { groups: [group([request.sourceId], input.candidates.map(candidate => candidate.id), {
      workflow: request.workflow, problem: request.problem, desiredOutcome: request.desiredOutcome,
    })], excluded: [] };
  } };
  const first = await reviewProblems(candidates, [record], cache, reasoner);
  const reopened = await openIntelligenceCache(directory);
  const second = await reviewProblems(candidates, [record], reopened, reasoner);
  assert.equal(calls, 1); assert.deepEqual(second.groups, first.groups);
  const changed = { ...record, problemAnalysis: { ...record.problemAnalysis, problem: 'Failed webhook events cannot be recovered' } };
  await reviewProblems(candidates, [changed], reopened, reasoner);
  assert.equal(calls, 2, 'changed extraction changes the review prompt and cache identity');
});

test('review rejects unknown sources and cannot resurrect a promotion', async t => {
  const { cache } = await temporaryCache(t);
  const a = understoodSource(source('a'));
  const promotion = understoodSource(source('promo'), { classification: 'promotion', requesterRole: 'vendor', audience: '', workflow: '', problem: '', desiredOutcome: '', proposedProblemKey: null });
  const result = await reviewProblems([{ id: 'candidate', sourceIds: ['a', 'promo'] }], [a, promotion], cache, { complete: async prompt => ({
    groups: [group(['a', 'promo', 'invented-id'], reviewInput(prompt).candidates.map(candidate => candidate.id))], excluded: [],
  }) });
  assert.equal(result.groups.length, 0);
  const reasons = result.rejected.flatMap(row => row.reasons);
  assert.ok(reasons.some(reason => /not a validated request: promo/.test(reason)));
  assert.ok(reasons.some(reason => /Unknown candidate source: invented-id/.test(reason)));
});

test('large candidate reviews are bounded without dropping or duplicating evidence', () => {
  const ids = Array.from({ length: 103 }, (_, i) => `source-${i}`);
  const batches = reviewBatches([{ id: 'large', sourceIds: ids }], 45);
  assert.deepEqual(batches.map(batch => batch.reduce((count, candidate) => count + candidate.sourceIds.length, 0)), [45, 45, 13]);
  assert.deepEqual(batches.flatMap(batch => batch.flatMap(candidate => candidate.sourceIds)), ids);
});

test('recounting a model-analyzed corpus does not resurrect a rejected extraction as heuristic demand', async t => {
  const { cache } = await temporaryCache(t); const record = source('rejected-demand');
  const understood = await understandRequests({ records: [record] }, cache, { complete: async () => ({
    extractions: [extraction(record, { evidenceQuote: 'This quote was invented by the model and does not exist in the source.' })],
  }) });
  assert.equal(understood.requests.length, 0);
  const { recountSignals } = await import('../server/signals.mjs');
  const recounted = recountSignals({ records: understood.records, signals: [], analysis: { method: 'problem-understanding-and-review', classification: 'quote-validated-model-analysis', requestCount: 0 } });
  assert.equal(recounted.analysis.requestCount, 0, 'aggregate reviewed demand must remain zero after a rejected extraction');
});

test('bounded understanding reports pending records and resumes only the missing cache entries', async t => {
  const { cache } = await temporaryCache(t); let calls = 0;
  const records = [source('first'), source('second')];
  const reasoner = { complete: async prompt => {
    calls++; return { extractions: extractionInput(prompt).map(input => extraction({ id: input.sourceId, text: input.text })) };
  } };
  const partial = await understandRequests({ records }, cache, reasoner, () => {}, { maxNewRecords: 1 });
  assert.equal(partial.candidates, 2); assert.equal(partial.analyzed, 1); assert.equal(partial.pending, 1);
  assert.equal(partial.requests.length, 1); assert.equal(partial.records.find(record => !record.problemAnalysis).request, null);
  const complete = await understandRequests({ records }, cache, reasoner);
  assert.equal(complete.candidates, 2); assert.equal(complete.analyzed, 2); assert.equal(complete.pending, 0);
  assert.equal(complete.requests.length, 2); assert.equal(calls, 2, 'resuming analyzes only the uncached record');
});
