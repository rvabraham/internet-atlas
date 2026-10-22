import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeCorpus } from '../server/signals.mjs';
import { rankLeads, TOPICS } from '../server/data.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA } from '../server/problems.mjs';
import { COMPACT_EXTRACTION_SCHEMA, COMPACT_GROUP_REVIEW_SCHEMA } from '../server/compact.mjs';
import { GLOBAL_JOBS_SCHEMA } from '../server/global-jobs.mjs';
import { AUDIT_SCHEMA } from '../server/audit.mjs';

const meaning = { audience: 'Developers', workflow: 'Receive webhook events', problem: 'Failed deliveries lose order events', desiredOutcome: 'Retry failed webhook deliveries automatically' };
const source = index => ({ id: `s${String(index).padStart(3, '0')}`, source: 'github', author: `person${index}`, authorId: `github:person${index}`, recordType: 'post', status: 'open', topicId: 'integrations', date: new Date(Date.now() - 86400000).toISOString(), url: `https://github.com/example/app/issues/${index}`, title: 'Feature request: retry failed webhooks', text: 'I need failed webhook deliveries to retry automatically so an outage does not lose order events.' });
const records = count => Array.from({ length: count }, (_, index) => source(index));
const extraction = record => ({ sourceId: record.id, classification: 'request', requesterRole: 'user', ...meaning, evidenceQuote: record.text, confidence: .95, proposedProblemKey: null });
const job = indices => ({ label: 'Retry failed webhook deliveries', ...meaning, sourceIndices: indices });
const sourceData = prompt => JSON.parse(prompt.split('SOURCE_DATA = ')[1]);
const candidates = prompt => JSON.parse(prompt.split('CANDIDATES = ')[1].split('\nREQUEST_DATA = ')[0]);
function model(input, { compact = false, jobs = [job([0, 1])], review, audit } = {}) {
  const byId = new Map(input.map(record => [record.id, record]));
  return { compact, calls: [], async complete(prompt, schema) {
    this.calls.push({ prompt, schema });
    if (schema === EXTRACTION_SCHEMA || schema === COMPACT_EXTRACTION_SCHEMA) {
      const rows = sourceData(prompt).map(row => extraction(byId.get(row.sourceId)));
      return schema === COMPACT_EXTRACTION_SCHEMA ? { requests: rows, other: [] } : { extractions: rows };
    }
    if (schema === GLOBAL_JOBS_SCHEMA) return { jobs };
    if (schema === GROUP_REVIEW_SCHEMA || schema === COMPACT_GROUP_REVIEW_SCHEMA) {
      assert.ok(review, 'Unexpected local grouping review');
      return review(candidates(prompt), schema);
    }
    assert.equal(schema, AUDIT_SCHEMA);
    const rows = sourceData(prompt), pass = this.calls.filter(call => call.schema === AUDIT_SCHEMA).length;
    return audit ? audit(rows, pass) : { matches: rows.map(row => ({ sourceId: row.sourceId, sameProblem: true, confidence: .95, reason: 'Original words explicitly request retrying failed webhook deliveries.' })) };
  } };
}
const orthogonal = async texts => texts.map((_, index) => Array.from({ length: texts.length }, (_value, axis) => Number(index === axis)));
function independentEmbeddings(input) {
  let pass = 0;
  return async texts => {
    pass++;
    if (pass <= 2) return orthogonal(texts);
    assert.equal(texts.length, 1, 'Global retrieval should reuse all existing source vectors');
    return [Array.from({ length: input.length }, (_, index) => Number(index === 0))];
  };
}
async function indexed(input, reasoner, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-global-index-'));
  try {
    return await analyzeCorpus({ records: input, topics: TOPICS, fetchedAt: new Date().toISOString() }, directory, () => {}, { reasoner, embed: independentEmbeddings(input), concurrency: 1, ...options });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('global discovery unites distant requests, audits again at ten, preserves rejected/unmatched asks, and supplies the exact lead cohort', async () => {
  const input = records(13); input[10].authorId = input[0].authorId;
  const reasoner = model(input, { jobs: [job(Array.from({ length: 12 }, (_, index) => index))], audit: rows => ({ matches: rows.map(row => ({ sourceId: row.sourceId, sameProblem: row.sourceId !== 's011', confidence: .95, reason: 'This source requests the canonical retry outcome, or a different remedy.' })) }) });
  const corpus = await indexed(input, reasoner, { globalJobs: true });
  assert.equal(corpus.signals.length, 3);
  const group = corpus.signals.find(signal => signal.audit);
  assert.equal(group.sourceIds.length, 11);
  assert.equal(group.requesterCount, 10); assert.equal(group.tier.id, 'recurring');
  assert.equal(group.audit.inputCount, 11);
  assert.equal(corpus.analysis.auditedGroups, 1, 'Two audit stages are one published audited group');
  assert.equal(corpus.membershipAudits.length, 23);
  assert.deepEqual(corpus.analysis.globalJobs, { enabled: true, version: 'global-customer-jobs-v3', acceptedGroups: 1, publishedGroups: 1, assignedRequests: 11, auditDecisions: 12, errors: 0 });
  assert.equal(corpus.analysis.requestCount, 13);
  assert.equal(corpus.analysis.groupedRequestCount, 13);
  assert.equal(new Set(corpus.signals.flatMap(signal => signal.sourceIds)).size, 13);
  assert.equal(corpus.signals.find(signal => signal.sourceIds.includes('s011')).sourceIds.length, 1);
  assert.equal(corpus.signals.find(signal => signal.sourceIds.includes('s012')).sourceIds.length, 1);
  const leads = rankLeads(corpus, { title: group.label, sourceIds: ['s000'], problemIds: [group.id], revision: 1 });
  assert.equal(leads.length, 10);
  assert.ok(leads.every(lead => lead.matchKind === 'selected-problem' && lead.sourceIds.every(id => group.sourceIds.includes(id))));
});

test('global discovery defaults to real compact reasoners and explicit overrides work in either direction', async () => {
  for (const [compact, override, enabled] of [[false, undefined, false], [true, undefined, true], [true, false, false], [false, true, true]]) {
    const input = records(3), reasoner = model(input, { compact });
    const corpus = await indexed(input, reasoner, override === undefined ? {} : { globalJobs: override });
    assert.equal(corpus.analysis.globalJobs.enabled, enabled);
    assert.equal(reasoner.calls.filter(call => call.schema === GLOBAL_JOBS_SCHEMA).length, Number(enabled));
    assert.equal(corpus.signals.length, enabled ? 2 : 3);
    assert.equal(corpus.analysis.auditedGroups, Number(enabled));
  }
});

test('a locally excluded request never enters global discovery and a failed global hypothesis preserves all valid local asks', async () => {
  const input = records(3);
  const reasoner = model(input, { jobs: [job([0, 2])], review: groups => ({ groups: [{ candidateIds: [groups[0].id], sourceIds: ['s000'], label: 'Retry failed webhook deliveries', ...meaning, confidence: .95, coherence: 'coherent' }], excluded: [{ sourceId: 's001', reason: 'The source quotes a hypothetical customer instead of stating its own request.' }] }) });
  let pass = 0;
  const corpus = await indexed(input, reasoner, { globalJobs: true, embed: async texts => {
    pass++;
    return pass === 1 ? [[1, 0], [1, 0], [0, 1]] : orthogonal(texts);
  } });
  const inventory = JSON.parse(reasoner.calls.find(call => call.schema === GLOBAL_JOBS_SCHEMA).prompt.split('INVENTORY = ')[1]);
  assert.equal(inventory.length, 2);
  assert.equal(corpus.analysis.requestCount, 2);
  assert.equal(corpus.analysis.groupedRequestCount, 2);
  assert.equal(corpus.records.find(record => record.id === 's001').signalId, null);
  assert.equal(corpus.records.find(record => record.id === 's001').reviewDecision.status, 'excluded');
  assert.equal(corpus.signals.length, 2);
  assert.equal(corpus.analysis.globalJobs.acceptedGroups, 0);
  assert.equal(corpus.analysis.globalJobs.errors, 1);
  assert.equal(corpus.analysis.status, 'partial');
});

test('global rejection cannot rejoin via an identical local canonical ID below the ten-member gate', async () => {
  const input = records(4);
  const reasoner = model(input, { review: groups => ({ groups: [{ candidateIds: [groups[0].id], sourceIds: groups[0].sourceIds, label: 'Retry failed webhook deliveries', ...meaning, confidence: .95, coherence: 'coherent' }], excluded: [] }), audit: rows => ({ matches: rows.map(row => ({ sourceId: row.sourceId, sameProblem: ['s000', 's001'].includes(row.sourceId), confidence: .95, reason: 'Own request either matches retries or asks for another webhook remedy.' })) }) });
  const corpus = await indexed(input, reasoner, { globalJobs: true, embed: async texts => texts.map(() => [1, 0]) });
  const accepted = corpus.signals.find(signal => signal.audit);
  assert.deepEqual(accepted.sourceIds, ['s000', 's001']);
  assert.equal(corpus.signals.length, 3);
  assert.equal(new Set(corpus.signals.map(signal => signal.id)).size, 3);
  assert.equal(corpus.analysis.groupedRequestCount, 4);
  assert.equal(corpus.signals.find(signal => signal.sourceIds.includes('s002')).sourceIds.length, 1);
  assert.equal(corpus.signals.find(signal => signal.sourceIds.includes('s003')).sourceIds.length, 1);
});

test('a failed final ten-plus audit publishes independent asks instead of keeping the earlier global claim', async () => {
  const input = records(12);
  const reasoner = model(input, { jobs: [job(input.map((_, index) => index))], audit: (rows, pass) => ({ matches: rows.slice(pass > 1 ? 1 : 0).map(row => ({ sourceId: row.sourceId, sameProblem: true, confidence: .95, reason: 'Own explicit request supports the canonical retry outcome.' })) }) });
  const corpus = await indexed(input, reasoner, { globalJobs: true });
  assert.equal(corpus.signals.length, 12);
  assert.ok(corpus.signals.every(signal => signal.sourceIds.length === 1 && signal.requesterCount === 1));
  assert.equal(corpus.analysis.auditedGroups, 0);
  assert.equal(corpus.analysis.globalJobs.acceptedGroups, 1);
  assert.equal(corpus.analysis.globalJobs.publishedGroups, 0);
  assert.equal(corpus.analysis.globalJobs.assignedRequests, 0);
  assert.equal(corpus.analysis.groupedRequestCount, 12);
  assert.equal(corpus.analysis.status, 'partial');
  assert.equal(corpus.membershipAudits.length, 24);
});

test('real compact reasoners audit small local bundles by default while legacy thresholds remain configurable', async () => {
  for (const [compact, minAccounts, audited] of [[true, undefined, true], [false, undefined, false], [false, 2, true], [true, 10, false]]) {
    const input = records(4);
    input[2].text = 'I need to reproduce failed CI jobs locally without consuming another hosted runner.';
    input[3].text = 'I need a tool to import my existing repository into a self-hosted source forge.';
    const reasoner = model(input, { compact,
      review: (groups, schema) => ({ groups: [{ candidateIds: [groups[0].id], sourceIds: groups[0].sourceIds, label: 'Retry failed webhook deliveries', ...meaning, confidence: .95, coherence: 'coherent' }], excluded: [], ...(schema === COMPACT_GROUP_REVIEW_SCHEMA ? { singletons: [] } : {}) }),
      audit: rows => ({ matches: rows.map(row => ({ sourceId: row.sourceId, sameProblem: ['s000', 's001'].includes(row.sourceId), confidence: .95, reason: 'The original author either asks for retries or for an unrelated development workflow.' })) }),
    });
    const result = await indexed(input, reasoner, { globalJobs: false, ...(minAccounts === undefined ? {} : { minAccounts }), embed: async texts => texts.map(() => [1, 0]) });
    assert.equal(reasoner.calls.filter(call => call.schema === AUDIT_SCHEMA).length, Number(audited));
    assert.equal(result.signals.length, audited ? 3 : 1);
    assert.equal(result.analysis.requestCount, 4);
    assert.equal(result.analysis.groupedRequestCount, 4);
    if (audited) {
      assert.deepEqual(result.signals.find(signal => signal.audit).sourceIds, ['s000', 's001']);
      assert.equal(result.signals.find(signal => signal.sourceIds.includes('s002')).sourceIds.length, 1);
      assert.equal(result.signals.find(signal => signal.sourceIds.includes('s003')).sourceIds.length, 1);
    }
  }
});
