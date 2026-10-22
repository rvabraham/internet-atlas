import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA, buildExtractionPrompt, buildGroupReviewPrompt, validateExtractions, validateGroupReview } from '../server/problems.mjs';
import { COMPACT_EXTRACTION_SCHEMA, COMPACT_GROUP_REVIEW_SCHEMA, buildCompactExtractionPrompt, normalizeCompactExtractions, buildCompactGroupReviewPrompt, normalizeCompactGroupReview } from '../server/compact.mjs';
import { understandRequests, reviewProblems } from '../server/intelligence.mjs';

const source = (id = 'gh:1', changes = {}) => ({ id, source: 'github', author: `person${id}`, authorId: `github:person${id}`, title: 'Feature request: retry failed webhook deliveries', text: 'I need failed webhook deliveries to retry automatically so an outage does not lose order events.', date: new Date(Date.now() - 86400000).toISOString(), url: `https://github.com/example/app/issues/${id.replace(/\W/g, '')}`, status: 'open', topicId: 'integrations', recordType: 'post', ...changes });
const row = (record, changes = {}) => ({ sourceId: record.id, classification: 'request', audience: 'Developers', workflow: 'Receive order webhook events', problem: 'Failed webhook deliveries lose order events', desiredOutcome: 'Retry failed webhook deliveries automatically', evidenceQuote: record.text, confidence: .92, requesterRole: 'user', proposedProblemKey: null, ...changes });
const calendar = () => source('gh:2', { title: 'Feature request: private calendar availability', text: 'I need to share free calendar slots without exposing private event titles.' });
const calendarRow = record => row(record, { audience: 'Calendar users', workflow: 'Share calendar availability', problem: 'Sharing calendars exposes private event titles', desiredOutcome: 'Share free calendar slots without exposing private event titles' });
const cache = () => ({ data: { extractions: {}, reviews: {} }, async save() {} });

test('compact nonrequests preserve model classification, literal evidence and confidence without invented descriptors', () => {
  const request = source(), discussion = source('gh:other', { text: 'This release note discusses the existing webhook software configuration.' });
  const compact = { requests: [row(request)], other: [{ sourceId: discussion.id, classification: 'discussion', evidenceQuote: discussion.text, confidence: .87 }] };
  const normalized = normalizeCompactExtractions(compact);
  const checked = validateExtractions(normalized, [request, discussion]);
  assert.equal(checked.accepted.length, 2);
  const other = checked.accepted.find(item => item.sourceId === discussion.id);
  assert.equal(other.classification, 'discussion'); assert.equal(other.confidence, .87);
  assert.equal(other.evidenceQuote, discussion.text);
  assert.equal(other.requesterRole, 'unknown'); assert.equal(other.proposedProblemKey, null);
  for (const field of ['audience', 'workflow', 'problem', 'desiredOutcome']) assert.equal(other[field], '');
  const fullOther = normalized.extractions[1];
  assert.ok(JSON.stringify(compact.other[0]).length < JSON.stringify(fullOther).length);
});

test('compact normalization cannot conceal quote hallucinations, unknown IDs, duplicates or missing records', () => {
  const records = [source(), source('gh:2')];
  const badQuote = normalizeCompactExtractions({ requests: [], other: [{ sourceId: 'gh:1', classification: 'discussion', evidenceQuote: 'A sentence the author never wrote.', confidence: .9 }] });
  assert.equal(validateExtractions(badQuote, records).accepted.length, 0);
  const unknown = normalizeCompactExtractions({ requests: [], other: [{ sourceId: 'invented', classification: 'discussion', evidenceQuote: records[0].text, confidence: .9 }] });
  assert.equal(validateExtractions(unknown, records).accepted.length, 0);
  const duplicate = normalizeCompactExtractions({ requests: [row(records[0])], other: [{ sourceId: 'gh:1', classification: 'discussion', evidenceQuote: records[0].text, confidence: .9 }] });
  assert.equal(validateExtractions(duplicate, records).accepted.length, 0);
  assert.ok(validateExtractions(normalizeCompactExtractions({ requests: [row(records[0])], other: [] }), records).rejected.some(item => item.sourceId === 'gh:2'));
  assert.throws(() => normalizeCompactExtractions({ requests: [], other: [{ sourceId: 'gh:1', classification: 'request', evidenceQuote: records[0].text, confidence: .9 }] }), /invalid shape/);
  assert.throws(() => normalizeCompactExtractions({ requests: [], other: [], requesterCount: 50 }), /invalid shape/);
});

test('compact singleton review derives only validated existing meanings and keeps existing membership validation', () => {
  const records = [source(), calendar()], rows = [row(records[0]), calendarRow(records[1])];
  const candidates = [{ id: 'candidate:1', sourceIds: records.map(record => record.id) }];
  const normalized = normalizeCompactGroupReview({ groups: [], singletons: ['gh:1', 'gh:2'], excluded: [] }, candidates, records, rows);
  const checked = validateGroupReview(normalized, candidates, records, rows);
  assert.equal(checked.accepted.length, 2);
  assert.equal(checked.accepted[0].workflow, rows[0].workflow);
  assert.equal(checked.accepted[0].confidence, rows[0].confidence);
  assert.deepEqual(checked.accepted[0].candidateIds, ['candidate:1']);
  for (const singletons of [['invented'], ['gh:1', 'gh:1']]) {
    const output = normalizeCompactGroupReview({ groups: [], singletons, excluded: [] }, candidates, records, rows);
    assert.equal(validateGroupReview(output, candidates, records, rows).accepted.length, 0);
  }
  const hallucinated = [{ ...rows[0], evidenceQuote: 'An invented quote.' }, rows[1]];
  const output = normalizeCompactGroupReview({ groups: [], singletons: ['gh:1'], excluded: [] }, candidates, records, hallucinated);
  assert.equal(validateGroupReview(output, candidates, records, hallucinated).accepted.length, 0);
});

test('compact prompt wrappers inherit the current semantic and security rules and schemas require every field', () => {
  const records = [source()], rows = [row(records[0])], candidates = [{ id: 'candidate:1', sourceIds: ['gh:1'] }];
  assert.ok(buildCompactExtractionPrompt(records).endsWith(buildExtractionPrompt(records)));
  assert.ok(buildCompactGroupReviewPrompt(candidates, records, rows).endsWith(buildGroupReviewPrompt(candidates, records, rows)));
  assert.match(buildCompactExtractionPrompt(records), /actual confidence/);
  assert.match(buildCompactGroupReviewPrompt(candidates, records, rows), /exactly once across groups, singletons and excluded/);
  const check = schema => {
    if (schema.type === 'object') { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties)); Object.values(schema.properties).forEach(check); }
    if (schema.items) check(schema.items);
    schema.anyOf?.forEach(check);
  };
  check(COMPACT_EXTRACTION_SCHEMA); check(COMPACT_GROUP_REVIEW_SCHEMA);
});

test('compact reasoning is explicitly opt-in and extraction caches contain the unchanged validated contract', async () => {
  const records = [source(), source('gh:2', { text: 'This software release adds documentation for existing webhook settings.' })];
  const compactCache = cache(); let calls = 0;
  const compact = { compact: true, async complete(_prompt, schema) { calls++; assert.equal(schema, COMPACT_EXTRACTION_SCHEMA); return { requests: [row(records[0])], other: [{ sourceId: 'gh:2', classification: 'discussion', evidenceQuote: records[1].text, confidence: .9 }] }; } };
  const result = await understandRequests({ records }, compactCache, compact, () => {}, { concurrency: 1 });
  assert.equal(result.requests.length, 1); assert.equal(result.analyzed, 2);
  const cached = Object.values(compactCache.data.extractions);
  assert.equal(cached.length, 2);
  assert.ok(cached.every(item => Object.hasOwn(item, 'desiredOutcome') && Object.hasOwn(item, 'evidenceQuote')));
  await understandRequests({ records }, compactCache, compact, () => {}, { concurrency: 1 });
  assert.equal(calls, 1);
  const legacy = { async complete(_prompt, schema) { assert.equal(schema, EXTRACTION_SCHEMA); return { extractions: records.map(record => row(record)) }; } };
  assert.equal((await understandRequests({ records }, cache(), legacy, () => {}, { concurrency: 1 })).analyzed, 2);
});

test('compact review caches normalize singleton shorthand before applying existing validators and reuse full-prompt cache hits', async () => {
  const records = [source(), calendar()], rows = [row(records[0]), calendarRow(records[1])];
  const prepared = records.map((record, i) => ({ ...record, problemAnalysis: rows[i] }));
  const candidates = [{ id: 'candidate:1', sourceIds: records.map(record => record.id) }], saved = cache(); let calls = 0;
  const compact = { compact: true, async complete(_prompt, schema) { calls++; assert.equal(schema, COMPACT_GROUP_REVIEW_SCHEMA); return { groups: [], singletons: records.map(record => record.id), excluded: [] }; } };
  const result = await reviewProblems(candidates, prepared, saved, compact, () => {}, { concurrency: 1 });
  assert.equal(result.groups.length, 2);
  const [entry] = Object.values(saved.data.reviews);
  assert.ok(!Object.hasOwn(entry, 'singletons')); assert.equal(entry.groups.length, 2);
  await reviewProblems(candidates, prepared, saved, compact, () => {}, { concurrency: 1 });
  assert.equal(calls, 1);
  const legacy = { async complete(_prompt, schema) { assert.equal(schema, GROUP_REVIEW_SCHEMA); return { groups: [], excluded: [] }; } };
  await reviewProblems(candidates, prepared, cache(), legacy, () => {}, { concurrency: 1 });
});
