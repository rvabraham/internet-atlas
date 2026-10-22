import { randomUUID } from 'node:crypto';
import { hnRecord, stackRecord, createPublicCollectorClient, checkCollectionCancelled } from './sources.mjs';
import { detectRequest } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

// These are retrieval hypotheses, never group membership or demand counts.
export const EXPANSION_FAMILIES = [
  { id: 'chat-history', label: 'Search previous AI chats', hn: ['chatgpt history', 'chatgpt search', 'chatgpt old chats', 'chatgpt conversations', 'claude history', 'search conversations', 'search chat history', 'chatgpt folders'], reddit: [{ community: 'ChatGPT', query: '(search OR find) AND (history OR conversation OR chats)' }, { community: 'ClaudeAI', query: '(search OR find) AND (history OR chats)' }, { community: 'ChatGPT', query: '"old chats" OR "conversation history"' }] },
  { id: 'chat-export', label: 'Export and retain AI conversations', hn: ['chatgpt export', 'export conversations', 'chatgpt backup', 'chatgpt markdown', 'claude export', 'chatgpt archive', 'download chatgpt', 'save conversations'], reddit: [{ community: 'ChatGPT', query: '(export OR backup OR download) AND (conversation OR chats)' }, { community: 'ClaudeAI', query: '(export OR backup) AND (conversation OR chats)' }] },
  { id: 'pdf-search', label: 'Search local PDF collections', hn: ['search pdf', 'search pdfs', 'pdf fulltext', 'pdf full text', 'local document search', 'offline document search', 'search scanned documents', 'search multiple pdf', 'pdf index', 'ripgrep pdf'], reddit: [{ community: 'selfhosted', query: '(search OR fulltext) AND (PDF OR documents)' }, { community: 'software', query: '(search OR index) AND PDF' }, { community: 'DataHoarder', query: '(search OR fulltext) AND PDF' }] },
  { id: 'calendar-sync', label: 'Share availability across calendars', hn: ['calendar sync', 'calendar availability', 'multiple calendars', 'calendar free busy', 'outlook google calendar', 'sync calendars', 'calendar conflicts', 'calendar two way', 'caldav sync', 'calendar block time'], reddit: [{ community: 'selfhosted', query: '(calendar OR calendars) AND (sync OR availability)' }, { community: 'GoogleCalendar', query: '(multiple OR outlook) AND (sync OR availability)' }, { community: 'productivity', query: '(calendars OR calendar) AND (sync OR availability)' }] },
  { id: 'webhook-replay', label: 'Recover failed webhook events', hn: ['webhook replay', 'webhook retry', 'webhook delivery', 'webhook debug', 'webhook logs', 'webhook failures', 'replay events', 'webhook idempotency'], reddit: [{ community: 'n8n', query: 'webhook AND (retry OR replay OR delivery OR duplicate)' }, { community: 'webdev', query: 'webhook AND (retry OR replay OR delivery)' }] },
  { id: 'read-later', label: 'Keep read later articles across devices', hn: ['read later', 'readlater', 'self hosted bookmarks', 'wallabag sync', 'readwise alternative', 'pocket alternative', 'bookmark sync', 'offline articles', 'linkding', 'article highlights'], reddit: [{ community: 'selfhosted', query: '"read later" OR "pocket alternative" OR "bookmark sync"' }, { community: 'software', query: '"read later" OR "offline articles"' }, { community: 'DataHoarder', query: '"read later" OR "bookmark sync"' }] },
];
export const BROAD_REQUEST_QUERIES = ['"I wish"', '"looking for a tool"', '"is there a tool"', '"wish there was"', '"I would pay"', '"need a tool"', '"feature request"', '"please add"', '"I need" software', '"I want" app', '"we need" workflow', '"recommend" software'];
const day = 86400;
const unique = values => [...new Set(values)];

export function expansionPlan(options = {}) {
  const selected = options.families?.length ? EXPANSION_FAMILIES.filter(family => options.families.includes(family.id)) : EXPANSION_FAMILIES;
  if (!selected.length) throw new Error('Choose an existing expansion family.');
  const from = options.from ? Math.floor(Date.parse(options.from) / 1000) : Math.floor(Date.now() / 1000) - 365 * day;
  const to = options.to ? Math.floor(Date.parse(options.to) / 1000) : Math.floor(Date.now() / 1000) + 1;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Expansion requires valid from/to dates in order.');
  return { families: selected, from, to, hn: selected.flatMap(family => unique(family.hn).map(query => ({ family: family.id, query }))), broad: options.broad === false ? [] : BROAD_REQUEST_QUERIES.map(query => ({ family: 'explicit-software-asks', query })), reddit: selected.flatMap(family => family.reddit.map(search => ({ ...search, family: family.id }))) };
}

/** Algolia exposes at most 1,000 hits per search. Divide time, never infer unseen counts. */
export async function collectHnDateWindows(query, { client, from, to, onHits = () => {}, onWindow = () => {}, signal, canContinue = () => true, maxRequests = 100, minWindowSeconds = day, maxDepth = 16, pageSize = 1000 } = {}) {
  if (!client || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('A client and valid HN date window are required.');
  pageSize = Math.max(1, Math.min(1000, Number(pageSize) || 1000));
  const queue = [{ from, to, depth: 0 }], windows = []; let requests = 0, rawHits = 0, paginationIncomplete = false;
  while (queue.length && requests < maxRequests && canContinue()) {
    checkCollectionCancelled(signal);
    const window = queue.shift();
    const filters = `created_at_i>=${window.from},created_at_i<${window.to}`;
    const endpoint = page => `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(comment,ask_hn)&hitsPerPage=${pageSize}&page=${page}&numericFilters=${encodeURIComponent(filters)}`;
    try {
      requests++; let data = await client.request('hn', endpoint(0));
      let hits = data.hits || []; rawHits += hits.length;
      await onHits(hits, { query, ...window, page: 0, endpoint: endpoint(0) });
      const totalHits = Number(data.nbHits || 0), split = totalHits > 1000 && window.to - window.from > minWindowSeconds && window.depth < maxDepth;
      const entry = { query, from: window.from, to: window.to, depth: window.depth, status: 'ok', rawCount: hits.length, totalHits, split, truncated: totalHits > 1000 && !split };
      windows.push(entry); await onWindow(entry);
      if (split) {
        const middle = Math.floor((window.from + window.to) / 2);
        // Newer evidence gets collected first. Adjacent half-open ranges cannot overlap.
        queue.unshift({ from: middle, to: window.to, depth: window.depth + 1 }, { from: window.from, to: middle, depth: window.depth + 1 });
      } else {
        const effectiveSize = Number(data.hitsPerPage) || pageSize;
        const pages = Math.min(Number(data.nbPages) || Math.ceil(Math.min(totalHits, 1000) / effectiveSize), Math.ceil(1000 / effectiveSize));
        for (let page = 1; page < pages && requests < maxRequests && canContinue(); page++) {
          checkCollectionCancelled(signal); requests++; data = await client.request('hn', endpoint(page));
          hits = data.hits || []; rawHits += hits.length; entry.rawCount += hits.length;
          await onHits(hits, { query, ...window, page, endpoint: endpoint(page) });
          if (!hits.length) break;
        }
        if (entry.rawCount < Math.min(totalHits, 1000)) paginationIncomplete = true;
      }
    } catch (error) {
      checkCollectionCancelled(signal);
      const entry = { query, from: window.from, to: window.to, depth: window.depth, status: 'error', error: error.message };
      windows.push(entry); await onWindow(entry);
      if (client.disabled('hn')) break;
    }
  }
  return { query, requests, rawHits, windows, incomplete: Boolean(queue.length) || paginationIncomplete };
}

export async function expandPublicRequests(previous = { records: [] }, onProgress = () => {}, options = {}) {
  const signal = options.signal; checkCollectionCancelled(signal);
  const plan = expansionPlan(options), startedAt = new Date().toISOString();
  const limits = { maxNewRecords: Math.max(1, Math.min(15000, Number(options.maxNewRecords) || 10000)), hnRequests: Math.max(1, Math.min(1000, Number(options.hnRequests) || 500)), redditRequests: Math.max(0, Math.min(60, options.redditRequests === undefined ? 20 : Number(options.redditRequests))), stackPages: Math.max(0, Math.min(100, options.stackPages === undefined ? 40 : Number(options.stackPages))) };
  const attempts = [], rateState = options.rateState || {};
  const client = options.client || createPublicCollectorClient({ ...options, attempts, rateState, resumeAfterBackoff: true, intervals: { hn: 350, reddit: 20000, stackexchange: 1200, ...(options.intervals || {}) } });
  const providers = new Set(options.providers || ['hn', 'reddit', 'stackexchange']);
  const records = new Map((previous.records || []).map(record => [canonicalSourceUrl(record.url) || record.id, record]));
  const originalIds = new Set((previous.records || []).map(record => record.id));
  const seen = new Set(), health = [], queries = [], families = {};
  const stats = { rawHits: 0, normalized: 0, viableCandidates: 0, directedCandidates: 0, outsideWindow: 0, added: 0, duplicates: 0, nonRequests: 0, invalid: 0, endorsements: 0, sources: {}, uniqueAccounts: 0, recentAccounts: 0 };
  const run = { id: randomUUID(), startedAt, status: 'running', window: { from: new Date(plan.from * 1000).toISOString(), to: new Date(plan.to * 1000).toISOString() }, limits, stats, attempts: client.attempts || attempts, health, queries, families };
  const running = () => { checkCollectionCancelled(signal); return stats.added < limits.maxNewRecords; };
  function intake(found, provenance) {
    stats.rawHits += found.length;
    const familyStats = families[provenance.family] ||= { rawHits: 0, viableCandidates: 0, added: 0, duplicates: 0 };
    familyStats.rawHits += found.length;
    for (const record of found) {
      if (!running()) break;
      if (!record || !record.authorId || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > Date.now() || record.synthetic || ['closed', 'resolved', 'deleted', 'removed'].includes(record.status)) { stats.invalid++; continue; }
      stats.normalized++;
      if (Date.parse(record.date) < plan.from * 1000 || Date.parse(record.date) >= plan.to * 1000) { stats.outsideWindow++; continue; }
      const request = detectRequest(record);
      const authored = record.recordType === 'comment' ? record.text : `${record.title} ${record.text}`;
      const directedCandidate = !request && provenance.family !== 'explicit-software-asks' && /\b(?:i (?:need|wish|want)|we (?:need|want)|looking for|is there|how (?:do|can) (?:i|we)|any (?:way|tool|app))\b/i.test(authored) && /\b(?:search|find|export|download|save|backup|sync|synchronize|synchronise|availability|replay|retries|retry|recover|bookmark|bookmarks|offline|full.?text|archive|deduplicate|duplicate|restore|highlight)\b/i.test(authored) && !/\b(?:i (?:built|created|launched)|we (?:built|created|launched)|our (?:product|tool|platform)|looking for (?:feedback|testers|customers|clients))\b|^show hn:/i.test(authored);
      if (request?.type === 'endorsement') { stats.endorsements++; continue; }
      if (!request && !directedCandidate) { stats.nonRequests++; continue; }
      const key = canonicalSourceUrl(record.url);
      if (!key) { stats.invalid++; continue; }
      if (!seen.has(key)) { stats.viableCandidates++; familyStats.viableCandidates++; if (directedCandidate) stats.directedCandidates++; seen.add(key); }
      const old = records.get(key);
      if (old) { stats.duplicates++; familyStats.duplicates++; }
      else { stats.added++; familyStats.added++; stats.sources[record.source] = (stats.sources[record.source] || 0) + 1; }
      records.set(key, { ...old, ...record, id: old?.id || record.id, request: request || null, collectionCandidate: directedCandidate ? { family: provenance.family, query: provenance.query, runId: run.id, reason: 'explicit-workflow-ask' } : old?.collectionCandidate, collection: old?.collection || { ...provenance, collectedAt: new Date().toISOString(), runId: run.id, stage: 'request-candidate' } });
    }
  }
  function corpus() {
    const newRecords = [...records.values()].filter(record => !originalIds.has(record.id));
    stats.uniqueAccounts = new Set(newRecords.map(record => record.authorId)).size;
    stats.recentAccounts = new Set(newRecords.filter(record => Date.parse(record.date) >= Date.now() - 365 * day * 1000).map(record => record.authorId)).size;
    const history = [...(previous.expansions || []), ...(previous.expansion && !(previous.expansions || []).some(item => item.id === previous.expansion.id) ? [previous.expansion] : [])];
    return { ...previous, version: 4, fetchedAt: new Date().toISOString(), records: [...records.values()], expansion: run, expansions: [...history, run].slice(-20) };
  }
  async function checkpoint() { checkCollectionCancelled(signal); if (options.onCheckpoint) await options.onCheckpoint(corpus()); }
  let hnRequests = 0, redditRequests = 0, windowCount = 0;
  const hnFamilyRequests = {}, familyHnLimit = Math.max(8, Math.floor(limits.hnRequests * .6 / plan.families.length));
  run.hnFamilyLimit = familyHnLimit;
  async function hnQuery(item) {
    if (!providers.has('hn') || !running() || hnRequests >= limits.hnRequests || client.disabled('hn')) return;
    const focused = item.family !== 'explicit-software-asks', familyRemaining = focused ? familyHnLimit - (hnFamilyRequests[item.family] || 0) : limits.hnRequests;
    if (familyRemaining <= 0) return;
    const result = await collectHnDateWindows(item.query, { client, from: plan.from, to: plan.to, signal, maxRequests: Math.min(focused ? 12 : 40, familyRemaining, limits.hnRequests - hnRequests), canContinue: running,
      onHits: (hits, info) => intake(hits.map(hnRecord), { ...info, family: item.family, provider: 'hn' }),
      onWindow: async entry => { health.push({ provider: 'hn', family: item.family, ...entry }); onProgress({ phase: 'expanding', provider: 'hn', query: item.query, family: item.family, added: stats.added, rawHits: stats.rawHits, status: entry.status, error: entry.error }); if (++windowCount % 10 === 0) await checkpoint(); },
    });
    hnRequests += result.requests; hnFamilyRequests[item.family] = (hnFamilyRequests[item.family] || 0) + result.requests; queries.push({ provider: 'hn', family: item.family, ...result, windows: undefined });
  }
  async function redditQuery(item) {
    if (!providers.has('reddit') || !running() || redditRequests >= limits.redditRequests) return;
    if (client.disabled('reddit')) { health.push({ provider: 'reddit', family: item.family, query: item.query, status: 'backoff', error: client.disabled('reddit') }); return; }
    const endpoint = `https://www.reddit.com/r/${item.community}/search.rss?q=${encodeURIComponent(item.query)}&restrict_sr=on&sort=relevance&t=${plan.to - plan.from <= 366 * day ? 'year' : 'all'}&limit=100`;
    redditRequests++;
    try {
      const found = await client.request('reddit', endpoint, 'xml');
      intake(found, { family: item.family, query: item.query, community: item.community, endpoint, provider: 'reddit' });
      health.push({ provider: 'reddit', family: item.family, query: item.query, community: item.community, status: 'ok', rawCount: found.length });
    } catch (error) { checkCollectionCancelled(signal); health.push({ provider: 'reddit', family: item.family, query: item.query, community: item.community, status: 'error', error: error.message }); }
    onProgress({ phase: 'expanding', provider: 'reddit', query: item.query, added: stats.added, rawHits: stats.rawHits });
  }
  for (const family of plan.families) {
    const searches = plan.hn.filter(item => item.family === family.id);
    for (let i = 0; i < searches.length && running(); i++) {
      await hnQuery(searches[i]);
      if (i < family.reddit.length) await redditQuery({ ...family.reddit[i], family: family.id });
      if ((i + 1) % 3 === 0) await checkpoint();
    }
    await checkpoint();
  }
  // Software Recommendations questions are explicit product searches with public attribution.
  if (providers.has('stackexchange')) for (let page = 1; page <= limits.stackPages && running(); page++) {
    if (client.disabled('stackexchange')) { health.push({ provider: 'stackexchange', status: 'backoff', error: client.disabled('stackexchange') }); break; }
    const endpoint = `https://api.stackexchange.com/2.3/questions?site=softwarerecs&pagesize=100&page=${page}&sort=creation&order=desc&filter=withbody&fromdate=${plan.from}`;
    try {
      const result = await client.request('stackexchange', endpoint), hits = result.items || [];
      intake(hits.map(stackRecord), { family: 'software-recommendation-questions', query: 'Software Recommendations questions', page, endpoint, provider: 'stackexchange' });
      health.push({ provider: 'stackexchange', page, status: 'ok', rawCount: hits.length, quotaRemaining: result.quota_remaining });
      onProgress({ phase: 'expanding', provider: 'stackexchange', page, added: stats.added, rawHits: stats.rawHits });
      if (page % 5 === 0) await checkpoint();
      if (!result.has_more) break;
    } catch (error) { checkCollectionCancelled(signal); health.push({ provider: 'stackexchange', page, status: 'error', error: error.message }); if (client.disabled('stackexchange')) break; }
  }
  for (const query of plan.broad) { if (!running() || hnRequests >= limits.hnRequests) break; await hnQuery(query); await checkpoint(); }
  run.completedAt = new Date().toISOString(); run.status = health.some(entry => entry.status === 'error' || entry.status === 'backoff' || entry.truncated) ? 'partial' : 'complete';
  run.bounded = stats.added >= limits.maxNewRecords || hnRequests >= limits.hnRequests || queries.some(query => query.incomplete);
  if (run.bounded && run.status === 'complete') run.status = 'partial';
  const result = corpus(); await checkpoint();
  onProgress({ phase: 'expanded', added: stats.added, rawHits: stats.rawHits, viableCandidates: stats.viableCandidates, sources: stats.sources, status: run.status });
  checkCollectionCancelled(signal); return result;
}
