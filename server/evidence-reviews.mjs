import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableProblemId, PROBLEM_CONTRACT_VERSION } from './problems.mjs';
import { requestFor } from './requests.mjs';
import { requestRecords, recountSignals } from './signals.mjs';

export const DEFAULT_EVIDENCE_REVIEWS = JSON.parse(readFileSync(new URL('../data/evidence-reviews.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
export const sourceReviewHash = record => sha([String(record.title || ''), String(record.text || '')]);
export const problemReviewHash = group => sha([String(group.workflow || ''), String(group.problem || ''), String(group.desiredOutcome || '')]);
const entries = reviews => Array.isArray(reviews?.reviews) ? reviews.reviews : [];
const statsFor = reviews => ({ version: reviews?.version || null, applied: 0, changed: 0, stale: 0, unmatched: 0, inactive: 0, invalid: 0 });
const valid = row => row && typeof row.id === 'string' && row.id && typeof row.sourceId === 'string' && typeof row.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(row.sourceHash) && typeof row.reason === 'string' && row.reason.length >= 20 && typeof row.sourceUrl === 'string' && row.sourceUrl.startsWith('https://');

/** Corrections are literal source passages, never replacement classifications. */
export function quoteReviews(records, reviews = DEFAULT_EVIDENCE_REVIEWS) {
  const output = records.slice(), positions = new Map(records.map((record, index) => [record.id, index])), stats = statsFor(reviews);
  for (const review of entries(reviews).filter(row => row.action === 'replace-quote')) {
    if (!valid(review) || typeof review.quote !== 'string' || normalize(review.quote).length < 10) { stats.invalid++; continue; }
    const position = positions.get(review.sourceId);
    if (position === undefined) { stats.unmatched++; continue; }
    const record = output[position];
    if (sourceReviewHash(record) !== review.sourceHash) { stats.stale++; continue; }
    const ownParts = record.recordType === 'comment' ? [record.text] : [record.title, record.text];
    if (!ownParts.some(text => normalize(text).includes(normalize(review.quote)))) { stats.invalid++; continue; }
    if (record.problemAnalysis?.classification !== 'request') { stats.inactive++; continue; }
    stats.applied++;
    if (record.problemAnalysis.evidenceQuote === review.quote) continue;
    const updated = { ...record, problemAnalysis: { ...record.problemAnalysis, evidenceQuote: review.quote, evidenceReview: { id: review.id, version: reviews.version, reviewedAt: reviews.reviewedAt } } };
    output[position] = { ...updated, request: requestFor(updated) }; stats.changed++;
  }
  return { records: output, stats };
}

/** Rejects a membership only for the exact source and canonical meaning reviewed. */
export function reviewMemberships(groups, records, reviews = DEFAULT_EVIDENCE_REVIEWS) {
  const sources = new Map(records.map(record => [record.id, record])), output = groups.map(group => ({ ...group, sourceIds: group.sourceIds.slice() }));
  const byId = new Map(output.map(group => [group.id, group])), rejected = new Set(), audits = [], stats = statsFor(reviews);
  for (const review of entries(reviews).filter(row => row.action === 'exclude-membership')) {
    if (!valid(review) || typeof review.problemId !== 'string' || !/^[a-f0-9]{64}$/.test(review.problemHash || '')) { stats.invalid++; continue; }
    const source = sources.get(review.sourceId), group = byId.get(review.problemId);
    if (!source || !group) { stats.unmatched++; continue; }
    if (sourceReviewHash(source) !== review.sourceHash || problemReviewHash(group) !== review.problemHash) { stats.stale++; continue; }
    stats.applied++;
    if (!group.sourceIds.includes(review.sourceId)) continue;
    const inputCount = Math.max(Number(group.audit?.inputCount) || group.sourceIds.length, group.sourceIds.length);
    group.sourceIds = group.sourceIds.filter(id => id !== review.sourceId);
    if (group.representativeId === review.sourceId) group.representativeId = group.sourceIds.slice().sort()[0] || null;
    const reviewIds = [...new Set([...(group.audit?.evidenceReviewIds || []), review.id])];
    const eligible = requestRecords(group.sourceIds.map(id => sources.get(id)).filter(Boolean));
    group.audit = { ...group.audit, status: ['verified', 'partial'].includes(group.audit?.status) ? 'partial' : 'unverified', inputCount, passedCount: eligible.length, rejectedCount: inputCount - eligible.length,
      distinctAccounts: new Set(eligible.map(record => ['github', 'reddit', 'x'].includes(record.source) ? `${record.source}:${record.authorId.toLowerCase()}` : `${record.source}:${record.authorId}`)).size,
      evidenceReviewVersion: reviews.version, evidenceReviewIds: reviewIds, manuallyRejectedCount: reviewIds.length, evidenceReviewedAt: reviews.reviewedAt };
    rejected.add(review.sourceId); stats.changed++;
    audits.push({ problemId: group.id, sourceId: review.sourceId, sourceUrl: review.sourceUrl, sameProblem: false, status: 'manual-rejected', reason: review.reason,
      reviewId: review.id, reviewVersion: reviews.version, reviewedAt: reviews.reviewedAt, method: 'full-source-review' });
  }
  return { groups: output.filter(group => group.sourceIds.length), rejectedIds: [...rejected], audits, stats };
}

export function individualProblem(record) {
  const p = record?.problemAnalysis;
  if (!record || !p || !requestFor(record) || ![p.workflow, p.problem, p.desiredOutcome].every(value => typeof value === 'string' && value.trim())) return null;
  const sourceSuffix = createHash('sha256').update(record.id).digest('hex').slice(0, 6);
  return { id: `${stableProblemId(p)}:${sourceSuffix}`, sourceIds: [record.id], representativeId: record.id,
    label: p.desiredOutcome.length > 95 ? `${p.desiredOutcome.slice(0, 92).replace(/\s+\S*$/, '')}…` : p.desiredOutcome,
    audience: p.audience, workflow: p.workflow, problem: p.problem, desiredOutcome: p.desiredOutcome,
    confidence: p.confidence, reviewed: true, inferred: true, reviewMethod: `${PROBLEM_CONTRACT_VERSION}:single-request` };
}

/** Apply the same overlays to an existing corpus without re-running any model. */
export function applyEvidenceReviews(corpus, reviews = DEFAULT_EVIDENCE_REVIEWS) {
  const quoted = quoteReviews(corpus.records, reviews), checked = reviewMemberships(corpus.signals || [], quoted.records, reviews);
  const assigned = new Set(checked.groups.flatMap(group => group.sourceIds)), sources = new Map(quoted.records.map(record => [record.id, record]));
  const singles = checked.rejectedIds.filter(id => !assigned.has(id)).map(id => individualProblem(sources.get(id))).filter(Boolean);
  const audits = new Map((corpus.membershipAudits || []).map((row, index) => [row.reviewId ? `${row.reviewId}:${row.problemId}:${row.sourceId}` : `existing:${index}`, row]));
  for (const row of checked.audits) audits.set(`${row.reviewId}:${row.problemId}:${row.sourceId}`, row);
  const result = recountSignals({ ...corpus, records: quoted.records, signals: [...checked.groups, ...singles], membershipAudits: [...audits.values()] });
  const globalGroups = result.signals.filter(group => group.reviewMethod?.startsWith('global-customer-jobs-'));
  return { ...result, analysis: { ...result.analysis, signalCount: result.signals.length, groupedRequestCount: new Set(result.signals.flatMap(group => group.sourceIds)).size,
    auditedGroups: new Set(result.signals.filter(group => ['verified', 'partial'].includes(group.audit?.status)).map(group => group.id)).size,
    ...(result.analysis?.globalJobs ? { globalJobs: { ...result.analysis.globalJobs, publishedGroups: globalGroups.length, assignedRequests: new Set(globalGroups.flatMap(group => group.sourceIds)).size } } : {}),
    evidenceReviews: { version: reviews.version, quotes: quoted.stats, memberships: checked.stats } } };
}
