import test from 'node:test';
import assert from 'node:assert/strict';
import { opportunityCandidates } from '../server/opportunities.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const source = (id, changes = {}) => {
  const text = `I am looking for a tool to reconcile invoice payments across our stores. I manually copy invoice ${id} into a spreadsheet every week.`;
  return { id, source: 'reddit', author: `requester${id}`, authorId: `reddit:requester${id}`, url: `https://www.reddit.com/r/software/comments/post${id}/invoice/`, threadUrl: `https://www.reddit.com/r/software/comments/post${id}/invoice/`, profileUrl: `https://www.reddit.com/user/requester${id}/`, title: 'Invoice payment reconciliation tool', text, date: '2026-10-01T12:00:00Z', status: 'public', recordType: 'post', topicId: 'billing', problemAnalysis: { classification: 'request', requesterRole: 'user', confidence: .95, workflow: 'Reconcile invoice payments across stores', problem: 'Manual reconciliation loses payment status across stores', desiredOutcome: 'Reconcile invoice payments automatically', evidenceQuote: text }, ...changes };
};
const group = (id, records, changes = {}) => ({ id, label: 'Reconcile invoice payments across stores', sourceIds: records.map(record => record.id), representativeId: records[0]?.id, reviewed: true, confidence: .95, audience: 'Store operators', workflow: 'Reconcile invoice payments across stores', problem: 'Manual reconciliation loses payment status across stores', desiredOutcome: 'Reconcile invoice payments automatically', ...changes });
const corpus = (records, signals) => ({ records, signals });
const ranked = (records, signals) => opportunityCandidates(corpus(records, signals), { now: NOW });

test('payment outside a short extraction quote is literal requester language, not invented demand or validated buying intent', () => {
  const quote = 'I need to search old conversations without opening every chat.';
  const record = source('context', { text: `${quote} I would pay $5/month for this if I still owned my data.`, problemAnalysis: { ...source('context').problemAnalysis, evidenceQuote: quote } });
  const [candidate] = ranked([record], [group('context', [record])]);
  assert.equal(candidate.requesterCount, 1);
  assert.equal(candidate.evidence.payment.accountCount, 1);
  const [context] = candidate.evidence.payment.evidence;
  assert.equal(context.sourceId, record.id);
  assert.equal(context.quote, 'I would pay $5/month for this if I still owned my data.');
  assert.equal(context.requiresContextReview, true);
  assert.equal(candidate.evidence.sourceContext.payment.length, 0, 'do not repeat the same sentence in adjacent context');
});

test('cross-product repeated buyer jobs rank above many requests for a maintenance patch', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => source(`job${i}`, i % 2 ? { source: 'github', authorId: `github:job${i}`, url: `https://github.com/store${i % 3}/billing/issues/${i}`, threadUrl: `https://github.com/store${i % 3}/billing/issues/${i}`, repository: `store${i % 3}/billing` } : {}));
  const patchText = 'Please upgrade the deprecated dependency to support Node 24 version compatibility.';
  const patches = Array.from({ length: 30 }, (_, i) => source(`patch${i}`, { source: 'github', authorId: `github:patch${i}`, repository: 'vendor/client', url: `https://github.com/vendor/client/issues/${i}`, threadUrl: `https://github.com/vendor/client/issues/${i}`, text: patchText, problemAnalysis: { ...source('x').problemAnalysis, requesterRole: 'maintainer', evidenceQuote: patchText } }));
  const candidates = ranked([...patches, ...jobs], [group('patch', patches, { workflow: 'Upgrade deprecated dependencies', problem: 'Dependency version compatibility requires Node 24 support', desiredOutcome: 'Upgrade the dependency to Node 24' }), group('job', jobs, { audit: { status: 'verified' } })]);
  assert.equal(candidates[0].problemId, 'job');
  assert.equal(candidates[0].classification, 'product-opportunity');
  assert.equal(candidates[0].status, 'ready');
  assert.equal(candidates[0].requesterCount, 10);
  assert.equal(candidates[0].threadCount, 10);
  assert.equal(candidates[0].repositories.length, 3);
  assert.equal(candidates[1].classification, 'isolated-fix');
  assert.match(candidates[1].reasons.join(' '), /maintenance/);
});

test('50 comments from one account are one requester and one candidate customer', () => {
  const records = Array.from({ length: 50 }, (_, i) => source(`comment${i}`, { author: 'OnePerson', authorId: i % 2 ? 'github:OnePerson' : 'github:oneperson', source: 'github', repository: 'vendor/app', recordType: 'comment', url: `https://github.com/vendor/app/issues/42#issuecomment-${i}`, threadUrl: 'https://github.com/vendor/app/issues/42' }));
  const [candidate] = ranked(records, [group('one-person', records)]);
  assert.equal(candidate.requesterCount, 1);
  assert.equal(candidate.allTimeCount, 1);
  assert.equal(candidate.threadCount, 1);
  assert.equal(candidate.firstCustomerCohort.length, 1);
  assert.equal(candidate.firstCustomerCohort[0].sourceIds.length, 50);
  assert.notEqual(candidate.status, 'ready');
});

test('ten-plus opportunity readiness requires a completed membership audit rather than legacy counts alone', () => {
  const records = Array.from({ length: 12 }, (_, i) => source(`audit${i}`));
  const [unaudited] = ranked(records, [group('legacy', records)]);
  assert.equal(unaudited.classification, 'product-opportunity');
  assert.equal(unaudited.requesterCount, 12);
  assert.equal(unaudited.status, 'early');
  assert.match(unaudited.reasons.join(' '), /has not passed the independent large-group audit/);
  for (const status of ['verified', 'partial']) {
    const [audited] = ranked(records, [group('audited', records, { audit: { status } })]);
    assert.equal(audited.status, 'ready');
    assert.equal(audited.requesterCount, 12);
  }
  assert.deepEqual(ranked(records, [group('failed', records, { audit: { status: 'failed' } })]), []);
});

test('a repeated one-product feature retains its actual count but stays a product feature', () => {
  const text = 'Please add an option for a configurable retry timeout in this webhook endpoint.';
  const records = Array.from({ length: 12 }, (_, i) => source(`feature${i}`, { source: 'github', authorId: `github:feature${i}`, repository: 'vendor/app', url: `https://github.com/vendor/app/issues/${i}`, threadUrl: `https://github.com/vendor/app/issues/${i}`, text, problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: text } }));
  const [candidate] = ranked(records, [group('retry-option', records, { workflow: 'Configure webhook retry timeout', problem: 'Webhook endpoint retry timeout cannot be configured', desiredOutcome: 'Add an option for configuring retry timeout' })]);
  assert.equal(candidate.classification, 'product-feature');
  assert.equal(candidate.requesterCount, 12);
  assert.notEqual(candidate.status, 'ready');
  assert.match(candidate.reasons.join(' '), /Every request is in vendor\/app/);
});

test('neighboring problems never get merged or contribute each other demand counts', () => {
  const invoices = Array.from({ length: 6 }, (_, i) => source(`invoice${i}`));
  const budgets = Array.from({ length: 6 }, (_, i) => source(`budget${i}`, { text: 'I am looking for a tool to plan household budgets without connecting my bank account.', problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: 'I am looking for a tool to plan household budgets without connecting my bank account.' } }));
  const candidates = ranked([...invoices, ...budgets], [group('invoice', invoices), group('budget', budgets, { workflow: 'Plan household budgets', problem: 'Bank-connected budgets share private data', desiredOutcome: 'Plan budgets without bank access' })]);
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.requesterCount, 6);
    assert.deepEqual(candidate.problemIds, [candidate.problemId]);
    assert.equal(candidate.sourceIds.length, 6);
    assert.equal(candidate.status, 'early');
  }
});

test('archival requesters are labeled historical and cannot produce current ready demand', () => {
  const records = Array.from({ length: 15 }, (_, i) => source(`old${i}`, { date: '2023-04-01T12:00:00Z', origin: 'dataset' }));
  const [candidate] = ranked(records, [group('old', records)]);
  assert.equal(candidate.requesterCount, 0);
  assert.equal(candidate.allTimeCount, 15);
  assert.equal(candidate.historicalRequesterCount, 15);
  assert.equal(candidate.currentSourceIds.length, 0);
  assert.equal(candidate.status, 'historical');
  assert.ok(candidate.firstCustomerCohort.every(row => row.current === false));
});

test('an author with old and recent requests is counted once with recent evidence preferred', () => {
  const records = [source('old', { authorId: 'reddit:same', date: '2024-01-01T12:00:00Z' }), source('recent', { authorId: 'reddit:same' }), source('only-old', { date: '2024-01-01T12:00:00Z' })];
  const [candidate] = ranked(records, [group('mixed', records)]);
  assert.equal(candidate.requesterCount, 1);
  assert.equal(candidate.allTimeCount, 2);
  assert.equal(candidate.historicalRequesterCount, 1);
  assert.equal(candidate.firstCustomerCohort[0].requestEvidence[0].sourceId, 'recent');
});

test('payment and workaround evidence are literal quotes, never inferred buying intent', () => {
  const text = 'I would pay for a tool to reconcile invoice payments. I manually copy payments into a spreadsheet and need an offline alternative to our current app.';
  const record = source('paid', { text, problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: text } });
  const negative = 'I would not pay for invoice software. I am not willing to pay for this feature.';
  const rejectedPayment = source('not-paid', { text: negative, problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: negative } });
  const [candidate] = ranked([record, rejectedPayment], [group('payment', [record, rejectedPayment])]);
  assert.equal(candidate.evidence.payment.accountCount, 1);
  assert.equal(candidate.evidence.payment.evidence[0].quote, text);
  assert.equal(candidate.evidence.workarounds.accountCount, 1);
  assert.equal(candidate.evidence.alternativeSeeking.accountCount, 1);
  assert.equal(candidate.evidence.constraints.accountCount, 1);
  assert.equal(candidate.firstCustomerCohort[0].buyerStatus, 'unverified');
  assert.ok(!('tam' in candidate));
  assert.ok(!('willingnessToPay' in candidate));
});

test('figurative pay and a nonfinancial budget do not become payment evidence', () => {
  const texts = ['I would pay attention to a tool that reconciles invoice payments.', 'I am willing to pay respect to good software engineers.', 'Our budget is 20 requests per minute for invoice processing.'];
  const records = texts.map((text, i) => source(`figurative${i}`, { text, problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: text } }));
  const [candidate] = ranked(records, [group('figurative', records)]);
  assert.equal(candidate.evidence.payment.accountCount, 0);
});

test('all source IDs are retained when the first customer cohort preview is limited to 40', () => {
  const records = Array.from({ length: 55 }, (_, i) => source(`many${i}`));
  const [candidate] = ranked(records, [group('many', records)]);
  assert.equal(candidate.sourceIds.length, 55);
  assert.equal(candidate.currentSourceIds.length, 55);
  assert.equal(candidate.requesterCount, 55);
  assert.equal(candidate.cohortCount, 55);
  assert.equal(candidate.firstCustomerCohort.length, 40);
  assert.equal(candidate.cohortTruncated, true);
});

test('unreviewed groups and invalid, closed, vendor or synthetic members cannot create opportunity demand', () => {
  const real = source('real');
  const others = [source('discussion', { problemAnalysis: { ...real.problemAnalysis, classification: 'discussion' } }), source('vendor', { problemAnalysis: { ...real.problemAnalysis, requesterRole: 'vendor' } }), source('closed', { status: 'closed' }), source('private', { status: 'private' }), source('withdrawn', { status: 'withdrawn' }), source('opted-out', { opted_out: true }), source('synthetic', { synthetic: true }), source('future', { date: '2028-01-01T00:00:00Z' }), source('fake', { problemAnalysis: { ...real.problemAnalysis, evidenceQuote: 'This quote is not in the actual source.' } })];
  const candidates = ranked([real, ...others], [group('valid', [real, ...others]), group('unreviewed', [real], { reviewed: false })]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].sourceIds, ['real']);
  assert.equal(candidates[0].requesterCount, 1);
});

test('related alternatives remain unverified context and never add demand or invented companies', () => {
  const members = [source('one'), source('two'), source('three')];
  const quote = 'I use LedgerFox for invoice payments reconciliation across stores, and it works for me.';
  const discussion = source('alternative', { text: quote, problemAnalysis: { ...source('x').problemAnalysis, classification: 'discussion', evidenceQuote: quote } });
  const [candidate] = ranked([...members, discussion], [group('invoices', members)]);
  assert.equal(candidate.requesterCount, 3);
  assert.equal(candidate.counterEvidence.length, 1);
  assert.equal(candidate.counterEvidence[0].quote, quote);
  assert.equal(candidate.counterEvidence[0].sourceId, 'alternative');
  assert.equal(candidate.counterEvidence[0].sameProblemVerified, false);
  assert.equal(candidate.counterEvidence[0].contributesToDemand, false);
  assert.ok(!candidate.sourceIds.includes('alternative'));
});

test('query matching returns complete one-problem evidence and supports deterministic time and limits', () => {
  const invoices = [source('invoice')], calendar = [source('calendar', { text: 'I need to synchronize multiple calendars without revealing event titles.', problemAnalysis: { ...source('x').problemAnalysis, evidenceQuote: 'I need to synchronize multiple calendars without revealing event titles.' } })];
  const data = corpus([...invoices, ...calendar], [group('invoice', invoices), group('calendar', calendar, { label: 'Synchronize calendars', workflow: 'Synchronize calendars privately', problem: 'Calendar sharing reveals event titles', desiredOutcome: 'Synchronize availability privately' })]);
  const candidates = opportunityCandidates(data, { query: 'calendar', now: new Date(NOW), limit: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].problemId, 'calendar');
  assert.equal(candidates[0].asOf, new Date(NOW).toISOString());
  assert.throws(() => opportunityCandidates(data, { now: 'nonsense' }), /valid current date/);
});
