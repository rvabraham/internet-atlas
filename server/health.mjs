import { requestRecords } from './signals.mjs';

const definitions = [
  ['hn', 'Hacker News', 'Public API'], ['reddit', 'Reddit', 'Public feeds and attributed archives'],
  ['github', 'GitHub', 'Public API'], ['stackexchange', 'Software Recs', 'Public API'],
  ['x', 'X', 'API or attributed dataset'], ['linkedin', 'LinkedIn', 'Attributed dataset'],
];
const latest = values => values.filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
const cleanError = value => String(value || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/([?&](?:api_key|token|key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 240);

export function sourceHealth(corpus, now = new Date()) {
  const records = corpus.records || [], feeds = corpus.feeds || [];
  const requests = requestRecords(records), cutoff = now.getTime() - 365 * 86400000;
  const datasets = new Map();
  for (const record of records) if (record.dataset) {
    const key = `${record.dataset.url}:${record.source}`;
    const entry = datasets.get(key) || { ...record.dataset, source: record.source, recordCount: 0, lastFetchedAt: null };
    entry.recordCount++; entry.lastFetchedAt = latest([entry.lastFetchedAt, record.fetchedAt]); datasets.set(key, entry);
  }
  const sources = definitions.map(([source, name, access]) => {
    const rows = records.filter(record => record.source === source), asks = requests.filter(record => record.source === source);
    const attempts = feeds.filter(feed => feed.source === source || feed.platform === source);
    const lastAttemptAt = latest(attempts.map(feed => feed.fetchedAt || feed.at));
    // Assess the newest collection run instead of retaining an old failure forever.
    const newest = lastAttemptAt ? attempts.filter(feed => Date.parse(feed.fetchedAt || feed.at) >= Date.parse(lastAttemptAt) - 30 * 60000) : attempts;
    const good = newest.filter(feed => ['ok', 'complete', 'success'].includes(feed.status));
    const failed = newest.filter(feed => ['error', 'unavailable', 'rate-limited', 'blocked'].includes(feed.status));
    const lastFailure = failed.slice().sort((a, b) => Date.parse(b.fetchedAt || b.at) - Date.parse(a.fetchedAt || a.at))[0];
    const hasData = rows.length > 0, noAdapter = ['x', 'linkedin'].includes(source);
    let status = failed.length ? hasData || good.length ? 'partial' : 'unavailable' : hasData || good.length ? 'ok' : noAdapter ? 'not-connected' : 'unavailable';
    let message = lastFailure ? cleanError(lastFailure.error || lastFailure.message || 'Collection failed. Cached records are retained.') : null;
    if (!attempts.length && !hasData) message = source === 'x' ? 'No X API connection or attributable dataset.' : source === 'linkedin' ? 'No attributable dataset imported.' : 'No successful collection recorded.';
    if (!attempts.length && hasData) message = rows.some(record => record.dataset) ? 'Attributed dataset records. Live collection has not run.' : 'Cached records. No collection attempt recorded in this snapshot.';
    const datasetCount = [...datasets.values()].filter(dataset => dataset.source === source).length;
    return { source, name, status, access, recordCount: rows.length, requestCount: asks.length, recentRequestCount: asks.filter(record => Date.parse(record.date) >= cutoff && Date.parse(record.date) <= now.getTime()).length, independentRequesters: new Set(asks.map(record => record.authorId.toLowerCase())).size, feedsOk: good.length, feedsFailed: failed.length, lastFetchedAt: latest(rows.map(record => record.fetchedAt)), newestPostAt: latest(rows.map(record => record.date)), lastAttemptAt, retryAt: lastFailure?.retryAt || null, datasetCount, message };
  });
  const analysis = corpus.analysis || {};
  return { generatedAt: now.toISOString(), analysis: { status: analysis.status || 'not-analyzed', analyzedCount: analysis.analyzedCount || 0, pendingCount: analysis.pendingCount || 0, requestCount: requests.length, problemCount: corpus.signals?.length || 0, verifiedCurrentGroups10plus: (corpus.signals || []).filter(group => group.requesterCount >= 10 && ['verified', 'partial'].includes(group.audit?.status)).length }, sources, datasets: [...datasets.values()], collections: (corpus.collections || []).slice(-8).map(run => ({ query: run.query, startedAt: run.startedAt, completedAt: run.completedAt, examined: run.examined, added: run.added, errors: run.errors?.length || 0 })) };
}
