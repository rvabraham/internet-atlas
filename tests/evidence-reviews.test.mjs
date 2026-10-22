import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvidenceReviews, quoteReviews, reviewMemberships, sourceReviewHash, problemReviewHash } from '../server/evidence-reviews.mjs';
import { opportunityCandidates } from '../server/opportunities.mjs';
import { rankLeads } from '../server/data.mjs';

const meaning = { audience: 'AI chat users', workflow: 'Search existing AI conversation contents', problem: 'Useful details are hard to find in previous AI chats', desiredOutcome: 'Retrieve information from existing AI conversations' };
const source = index => ({ id: `source:${index}`, source: 'reddit', author: `person${index}`, authorId: `reddit:person${index}`, title: 'Looking for an AI conversation search tool', text: 'I am looking for a tool to search my existing AI conversations and retrieve earlier answers. please, give', url: `https://www.reddit.com/r/software/comments/post${index}/search/`, date: new Date(Date.now() - 86400000).toISOString(), status: 'public', recordType: 'post', topicId: 'agents', problemAnalysis: { ...meaning, classification: 'request', requesterRole: 'user', confidence: .95, evidenceQuote: index === 2 ? 'please, give' : 'I am looking for a tool to search my existing AI conversations and retrieve earlier answers.' } });
function fixture(count = 12, audited = true) {
  const records = Array.from({ length: count }, (_, index) => source(index));
  const group = { id: 'signal:retrieval', label: 'Retrieve information from AI conversations', ...meaning, sourceIds: records.map(record => record.id), representativeId: records[0].id, reviewed: true, confidence: .95, reviewMethod: 'global-customer-jobs-v3', ...(audited ? { audit: { version: 'blind-problem-membership-v2', model: 'gpt-6-luna', status: 'verified', inputCount: count, passedCount: count, rejectedCount: 0 } } : {}) };
  return { records, signals: [group], membershipAudits: [], analysis: { globalJobs: { publishedGroups: 1, assignedRequests: count } } };
}
function reviewsFor(corpus, ids = ['source:0', 'source:1']) {
  return { version: 'test-evidence-reviews-v1', reviewedAt: '2026-10-22T22:57:32.541Z', reviews: [
    ...ids.map((id, index) => ({ id: `reject-${index}`, action: 'exclude-membership', sourceId: id, sourceUrl: corpus.records.find(record => record.id === id).url, sourceHash: sourceReviewHash(corpus.records.find(record => record.id === id)), problemId: corpus.signals[0].id, problemHash: problemReviewHash(corpus.signals[0]), reason: 'Full source asks for a separate workflow rather than a person retrieving information from existing AI conversations.' })),
    { id: 'better-quote', action: 'replace-quote', sourceId: corpus.records[2].id, sourceUrl: corpus.records[2].url, sourceHash: sourceReviewHash(corpus.records[2]), quote: 'I am looking for a tool to search my existing AI conversations and retrieve earlier answers.', reason: 'Replace the uninformative excerpt with an existing contiguous literal sentence that states the actual request.' },
  ] };
}

test('versioned overlays recompute demand and exact leads while preserving rejected sources as independent valid problems', () => {
  const input = fixture(), original = structuredClone(input), reviews = reviewsFor(input);
  const result = applyEvidenceReviews(input, reviews), group = result.signals.find(group => group.id === 'signal:retrieval');
  assert.equal(group.requesterCount, 10); assert.equal(group.allTimeCount, 10);
  assert.equal(group.audit.status, 'partial'); assert.equal(group.audit.passedCount, 10); assert.equal(group.audit.rejectedCount, 2);
  assert.equal(group.audit.manuallyRejectedCount, 2); assert.equal(group.audit.distinctAccounts, 10);
  assert.equal(result.signals.length, 3); assert.equal(result.analysis.requestCount, 12); assert.equal(result.analysis.groupedRequestCount, 12);
  assert.equal(result.analysis.globalJobs.assignedRequests, 10);
  assert.equal(result.membershipAudits.filter(row => row.status === 'manual-rejected').length, 2);
  assert.equal(result.records[2].request.quote, reviews.reviews[2].quote);
  for (const id of ['source:0', 'source:1']) {
    const independent = result.signals.find(group => group.sourceIds.includes(id));
    assert.equal(independent.sourceIds.length, 1); assert.notEqual(independent.id, 'signal:retrieval');
    assert.equal(result.records.find(record => record.id === id).reviewDecision, undefined, 'A membership exclusion is not a source exclusion');
  }
  const leads = rankLeads(result, { title: group.label, problemIds: [group.id], sourceIds: [], revision: 1 });
  assert.equal(leads.length, 10); assert.ok(leads.every(lead => !lead.sourceIds.some(id => ['source:0', 'source:1'].includes(id))));
  assert.deepEqual(input, original, 'Applying overlays never mutates the incoming corpus');
});

test('standalone application is idempotent, including singleton identities and manual audit provenance', () => {
  const input = fixture(), reviews = reviewsFor(input);
  const first = applyEvidenceReviews(input, reviews), second = applyEvidenceReviews(first, reviews);
  const withoutRecountTime = groups => groups.map(({ asOf, ...group }) => group);
  assert.deepEqual(withoutRecountTime(second.signals), withoutRecountTime(first.signals));
  assert.deepEqual(second.membershipAudits, first.membershipAudits);
  assert.equal(second.analysis.evidenceReviews.memberships.changed, 0);
  assert.equal(second.analysis.evidenceReviews.memberships.applied, 2);
  assert.equal(second.analysis.evidenceReviews.quotes.changed, 0);
  assert.equal(second.analysis.evidenceReviews.quotes.applied, 1);
});

test('source content, source identity, canonical identity and canonical meaning prevent stale review application', () => {
  const original = fixture(), reviews = reviewsFor(original);
  const sourceChanged = structuredClone(original); sourceChanged.records[0].text += ' New evidence changes the reviewed source.';
  const changedSource = reviewMemberships(sourceChanged.signals, sourceChanged.records, reviews);
  assert.ok(changedSource.groups[0].sourceIds.includes('source:0')); assert.equal(changedSource.stats.stale, 1);
  for (const field of ['id', 'workflow', 'problem', 'desiredOutcome']) {
    const changed = structuredClone(original); changed.signals[0][field] += ' revised';
    const result = reviewMemberships(changed.signals, changed.records, reviews);
    assert.equal(result.groups[0].sourceIds.length, 12); assert.equal(result.rejectedIds.length, 0);
  }
  const differentId = structuredClone(original); differentId.records[0].id = 'another-source';
  const missing = reviewMemberships(differentId.signals, differentId.records, reviews);
  assert.ok(missing.groups[0].sourceIds.includes('source:0')); assert.equal(missing.stats.unmatched, 1);
});

test('quote corrections must be literal and source-bound and cannot turn a nonrequest into demand', () => {
  const input = fixture(), reviews = reviewsFor(input);
  const hallucinated = structuredClone(reviews); hallucinated.reviews[2].quote = 'I am willing to pay for an enterprise chat-search company.';
  const invalid = quoteReviews(input.records, hallucinated);
  assert.equal(invalid.stats.invalid, 1); assert.equal(invalid.records[2].problemAnalysis.evidenceQuote, 'please, give');
  const changed = structuredClone(input.records); changed[2].title += ' updated';
  assert.equal(quoteReviews(changed, reviews).stats.stale, 1);
  const nonrequest = structuredClone(input.records); nonrequest[2].problemAnalysis.classification = 'discussion';
  assert.equal(quoteReviews(nonrequest, reviews).stats.inactive, 1);
  assert.equal(quoteReviews(nonrequest, reviews).records[2].problemAnalysis.classification, 'discussion');
});

test('rejecting one member from an unaudited eleven-source group does not certify ten remaining requesters as ready', () => {
  const input = fixture(11, false), reviews = reviewsFor(input, ['source:0']);
  const result = applyEvidenceReviews(input, reviews), group = result.signals.find(group => group.id === 'signal:retrieval');
  assert.equal(group.requesterCount, 10); assert.equal(group.audit.status, 'unverified');
  assert.equal(result.analysis.auditedGroups, 0);
  const candidate = opportunityCandidates(result).find(candidate => candidate.problemId === group.id);
  assert.equal(candidate.classification, 'product-opportunity'); assert.equal(candidate.status, 'early');
  assert.match(candidate.reasons.join(' '), /has not passed the independent large-group audit/);
});
