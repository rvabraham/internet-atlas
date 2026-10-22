import { requestRecords } from './signals.mjs';

/** One original request per public account. Historical and current cohorts stay separate. */
export function opportunityCohort(candidate, records, { historical = false, now = new Date() } = {}) {
  const ids = new Set(candidate.sourceIds);
  const cutoff = now.getTime() - 365 * 86400000;
  const members = requestRecords(records.filter(record => ids.has(record.id)))
    .filter(record => Date.parse(record.date) <= now.getTime() && (historical || Date.parse(record.date) >= cutoff))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
  const accounts = new Set();
  return members.filter(record => {
    const key = `${record.source}:${['github', 'reddit', 'x'].includes(record.source) ? record.authorId.toLowerCase() : record.authorId}`;
    if (accounts.has(key)) return false;
    accounts.add(key); return true;
  });
}

export function opportunityEvidencePage(candidate, records, cursor = '', options = {}) {
  const cohort = opportunityCohort(candidate, records, options);
  const offset = cursor === '' ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > cohort.length) throw new Error('Invalid evidence cursor.');
  const evidence = cohort.slice(offset, offset + 40).map(record => ({ sourceId: record.id, source: record.source, author: record.author, authorId: record.authorId, date: record.date, url: record.url, profileUrl: record.profileUrl, title: record.title, quote: record.request.quote, origin: record.origin, dataset: record.dataset ? { name: record.dataset.name, url: record.dataset.url } : null }));
  return { evidence, totalAccounts: cohort.length, nextCursor: offset + evidence.length < cohort.length ? String(offset + evidence.length) : null };
}

/** Evidence-only framing is allowed during discovery; the chosen idea is untouched. */
export function prepareRecommendation(candidate, records, input, readIds, options = {}) {
  const current = opportunityCohort(candidate, records, options);
  const historical = !current.length;
  const cohort = historical ? opportunityCohort(candidate, records, { ...options, historical: true }) : current;
  const required = Math.min(10, cohort.length);
  if (!cohort.length || cohort.filter(record => readIds?.has(record.id)).length < required) throw new Error(`Read at least ${required || 1} distinct requesters for this opportunity before recommending it.`);
  const title = String(input.title || '').trim().slice(0, 160), description = String(input.description || '').trim().slice(0, 1200);
  if (!title || !description) throw new Error('Give the product a specific title and describe the customer workflow it would own.');
  if (/[—]/.test(title + description)) throw new Error('Rewrite the product title and description without em dashes.');
  return { problemId: candidate.problemId, title, description, sourceIds: cohort.map(record => record.id), requesterCount: current.length, allTimeCount: opportunityCohort(candidate, records, { ...options, historical: true }).length, windowDays: 365, historical, status: candidate.status, classification: candidate.classification };
}

export function recommendationReferences(recommendation, citedIds) {
  return recommendation && citedIds.some(id => recommendation.sourceIds.includes(id)) ? [...new Set([...citedIds, ...recommendation.sourceIds])] : citedIds;
}
