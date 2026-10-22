import test from 'node:test';
import assert from 'node:assert/strict';
import { attributableSource, requestFor } from '../server/requests.mjs';
import { opportunityCandidates } from '../server/opportunities.mjs';
import { rankLeads } from '../server/data.mjs';
import { requestRecords, summarizeSignal } from '../server/signals.mjs';

const text = 'I am looking for a tool to search my local PDF documents offline.';
const source = (id, changes = {}) => ({ id, source: 'reddit', author: `person${id}`, authorId: `reddit:person${id}`, profileUrl: `https://www.reddit.com/user/person${id}/`, title: 'Search local PDFs', text, url: `https://www.reddit.com/r/software/comments/${id}/pdf/`, date: new Date(Date.now() - 86400000).toISOString(), status: 'public', topicId: 'retrieval', problemAnalysis: { classification: 'request', requesterRole: 'user', confidence: .95, workflow: 'Search local PDF documents', problem: 'Finding text requires opening individual PDF documents', desiredOutcome: 'Search all local PDF documents offline', evidenceQuote: text }, ...changes });
const signal = records => ({ id: 'problem:pdf', reviewed: true, confidence: .95, label: 'Search local PDFs', sourceIds: records.map(record => record.id), representativeId: records[0]?.id, workflow: 'Search local PDF documents', problem: 'Finding text requires opening individual PDF documents', desiredOutcome: 'Search all local PDF documents offline' });

test('choosing an opportunity cannot resurrect unavailable or opted-out sources as requester leads', () => {
  const statuses = ['deleted', 'closed', 'resolved', 'removed', 'private', 'withdrawn', 'opted-out', 'opted_out', 'opted out', 'redacted', 'unavailable', 'PRIVATE'];
  const flags = ['deleted', 'removed', 'opted_out', 'optedOut', 'optOut', 'redacted', 'withdrawn', 'private', 'unavailable', 'is_deleted', 'is_removed', 'is_opted_out', 'is_redacted', 'is_withdrawn', 'is_private', 'is_unavailable'];
  const records = [source('public'), ...statuses.map((status, i) => source(`status${i}`, { status })), ...flags.map((flag, i) => source(`flag${i}`, { [flag]: true }))];
  const group = signal(records), corpus = { records, signals: [group] };
  const [candidate] = opportunityCandidates(corpus);
  assert.equal(candidate.requesterCount, 1);
  assert.deepEqual(candidate.sourceIds, ['public']);
  const leads = rankLeads(corpus, { title: candidate.label, sourceIds: candidate.sourceIds, problemIds: candidate.problemIds, revision: 1 });
  assert.deepEqual(leads.map(lead => lead.id), ['reddit:personpublic']);
  assert.equal(requestRecords(records).length, 1);
  assert.equal(summarizeSignal(group, new Map(records.map(record => [record.id, record]))).requesterCount, 1);
  assert.ok(records.slice(1).every(record => requestFor(record) === null));
});

test('placeholder authors do not become independent demand while ordinary names remain attributable', () => {
  for (const author of ['', ' ', 'unknown', 'UNKNOWN', 'anonymous', '[deleted]', '[removed]', 'deleted', 'AutoModerator', 'tool[bot]']) {
    assert.equal(attributableSource(source('placeholder', { author })), false, author);
  }
  assert.equal(attributableSource(source('ghost-github', { source: 'github', author: 'Ghost' })), false);
  for (const author of ['Ghost', 'AnonymousDeveloper', 'UnknownSoftware', 'alex']) assert.equal(attributableSource(source('real', { source: 'hn', author })), true, author);
});

test('boolean strings and numbers marking unavailability are honored without treating false as true', () => {
  for (const flag of ['is_private', 'synthetic', 'is_synthetic']) {
    for (const value of [true, 1, 'true', 'TRUE', 'yes', '1']) assert.equal(attributableSource(source('private', { [flag]: value })), false);
    for (const value of [false, 0, 'false', 'FALSE', 'no', '0', null, undefined]) assert.equal(attributableSource(source('public', { [flag]: value })), true);
  }
});
