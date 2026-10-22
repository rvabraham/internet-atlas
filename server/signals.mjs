import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requestFor, priorityTier } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';
import { stableProblemId, PROBLEM_CONTRACT_VERSION } from './problems.mjs';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const digest = text => createHash('sha256').update(text).digest('hex');
const requesterKey = record => ['github', 'reddit', 'x'].includes(record.source) ? record.authorId.toLowerCase() : record.authorId;
export const cosine = (a, b) => { let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; return dot; };
const normalize = vector => { const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1; return vector.map(x => x / norm); };

export function requestRecords(records) {
  const urls = new Set(), copies = new Set(), selected = [];
  for (const source of records) {
    const request = requestFor(source);
    if (!request || request.type === 'endorsement' || !source.authorId || !Number.isFinite(Date.parse(source.date))) continue;
    const canonical = canonicalSourceUrl(source.url);
    if (!canonical || urls.has(canonical)) continue;
    // Exact long cross-posts count once; short genuine repeated asks are not deduplicated by wording.
    const textKey = source.text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (textKey.length > 180 && copies.has(textKey)) continue;
    urls.add(canonical); if (textKey.length > 180) copies.add(textKey);
    selected.push({ ...source, request });
  }
  return selected;
}

export function clusterRequests(records, vectors, { threshold = .76, minAnchorSimilarity = .64 } = {}) {
  const clusters = [];
  for (let index = 0; index < records.length; index++) {
    const vector = vectors[index];
    let best = null, similarity = threshold;
    for (const cluster of clusters) {
      const score = cosine(vector, cluster.centroid);
      if (score > similarity && cluster.anchors.every(anchor => cosine(vector, vectors[anchor]) >= minAnchorSimilarity)) { best = cluster; similarity = score; }
    }
    if (!best) { clusters.push({ indices: [index], centroid: vector.slice(), anchors: [index] }); continue; }
    const size = best.indices.length;
    best.centroid = normalize(best.centroid.map((x, i) => x * size + vector[i]));
    best.indices.push(index);
    if (best.anchors.length < 4) best.anchors.push(index);
    else {
      const closest = best.anchors.map((anchor, i) => ({ i, score: cosine(vectors[anchor], best.centroid) })).sort((a, b) => b.score - a.score)[0];
      if (cosine(vector, best.centroid) < closest.score) best.anchors[closest.i] = index;
    }
  }
  return clusters.map(cluster => {
    const representative = cluster.indices.reduce((best, index) => cosine(vectors[index], cluster.centroid) > cosine(vectors[best], cluster.centroid) ? index : best, cluster.indices[0]);
    return { sourceIds: cluster.indices.map(index => records[index].id), representativeId: records[representative].id };
  });
}

export function summarizeSignal(group, records, now = new Date()) {
  const members = group.sourceIds.map(id => records.get(id)).filter(Boolean);
  const eligible = requestRecords(members).filter(record => Date.parse(record.date) <= now.getTime());
  const cutoff = now.getTime() - 365 * 86400000;
  const recent = eligible.filter(record => Date.parse(record.date) >= cutoff && Date.parse(record.date) <= now.getTime());
  const requesterCount = new Set(recent.map(requesterKey)).size;
  const allTimeCount = new Set(eligible.map(requesterKey)).size;
  const representative = members.find(record => record.id === group.representativeId) || members[0];
  if (!representative) return null;
  const topics = new Map(); for (const record of eligible) topics.set(record.topicId, (topics.get(record.topicId) || 0) + 1);
  const topicId = [...topics].sort((a, b) => b[1] - a[1])[0]?.[0] || representative.topicId;
  const labelText = representative.source === 'hn' && representative.recordType === 'comment' ? representative.request?.quote || representative.title : representative.title;
  const label = labelText.replace(/^\s*(?:\[(?:feature request|feature|feat|enhancement)\]:?|(?:feature request|enhancement|feat)\s*[:\-])\s*/i, '').trim().slice(0, 110);
  return { id: group.id || `signal:${digest(group.sourceIds.slice().sort().join('|')).slice(0, 14)}`, label, topicId, representativeId: representative.id, sourceIds: eligible.map(record => record.id), requesterCount, allTimeCount, archiveCount: new Set(recent.filter(record => record.origin === 'dataset').map(requesterKey)).size, threadCount: new Set(recent.map(record => canonicalSourceUrl(record.threadUrl || record.url))).size, platforms: [...new Set(recent.map(record => record.source))], paymentMentions: new Set(recent.filter(record => /\bi(?:'|’)d pay|\bi would pay|\bwilling to pay/i.test(record.request.quote)).map(requesterKey)).size, tier: priorityTier(requesterCount), asOf: now.toISOString(), windowDays: 365, inferred: true };
}

let extractorPromise;
export async function embedTexts(texts, directory, onProgress = () => {}, { persist = true } = {}) {
  await mkdir(directory, { recursive: true });
  if (!extractorPromise) extractorPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = resolve(directory, 'models'); env.allowLocalModels = false;
    onProgress({ phase: 'model', completed: 0, total: texts.length });
    return pipeline('feature-extraction', EMBEDDING_MODEL, { revision: EMBEDDING_REVISION, dtype: 'q8', device: 'cpu', progress_callback: progress => { if (progress.status === 'progress') onProgress({ phase: 'model', file: progress.file, progress: Math.round(progress.progress) }); } });
  })().catch(error => { extractorPromise = null; throw error; });
  const extractor = await extractorPromise;
  let cache = {};
  const cachePath = resolve(directory, 'embeddings.json');
  if (persist) try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* First local indexing. */ }
  const keys = texts.map(text => digest(`${EMBEDDING_MODEL}:${EMBEDDING_REVISION}:q8:v1:${text}`));
  const missing = [...new Set(keys)].filter(key => !cache[key]);
  const textForKey = new Map(keys.map((key, i) => [key, texts[i]]));
  for (let offset = 0; offset < missing.length; offset += 16) {
    const batchKeys = missing.slice(offset, offset + 16);
    const tensor = await extractor(batchKeys.map(key => textForKey.get(key)), { pooling: 'mean', normalize: true });
    const output = tensor.tolist(); batchKeys.forEach((key, i) => { cache[key] = output[i]; });
    onProgress({ phase: 'embedding', completed: Math.min(offset + 16, missing.length), total: missing.length });
  }
  if (persist && missing.length) {
    const temporary = `${cachePath}.tmp`; await writeFile(temporary, JSON.stringify(cache)); await rename(temporary, cachePath);
  }
  return keys.map(key => cache[key]);
}

export async function analyzeCorpus(corpus, directory, onProgress = () => {}, options = {}) {
  const { createReasoner, openIntelligenceCache, understandRequests, reviewProblems } = await import('./intelligence.mjs');
  const reasoner = options.reasoner || await createReasoner(directory);
  try {
    const cache = await openIntelligenceCache(directory);
    const understood = await understandRequests(corpus, cache, reasoner, onProgress, options);
    const { quoteReviews, reviewMemberships } = await import('./evidence-reviews.mjs');
    const reviewedQuotes = quoteReviews(understood.records);
    understood.records = reviewedQuotes.records;
    const quotedSources = new Map(understood.records.map(record => [record.id, record]));
    understood.requests = understood.requests.map(record => quotedSources.get(record.id) || record);
    options.signal?.throwIfAborted();
    const requests = requestRecords(understood.requests).sort((a, b) => a.id.localeCompare(b.id));
    const texts = requests.map(record => { const p = record.problemAnalysis; return `${p.workflow}. ${p.problem}. Desired outcome: ${p.desiredOutcome}`; });
    const vectors = requests.length ? await (options.embed || embedTexts)(texts, directory, onProgress) : [];
    options.signal?.throwIfAborted();
    onProgress({ phase: 'clustering', completed: 0, total: requests.length });
    // Retrieval is deliberately broader than final membership. Semantic review and
    // the independent large-group audit decide whether requests actually match.
    const candidates = clusterRequests(requests, vectors, { threshold: .48, minAnchorSimilarity: .32 }).map(group => ({ ...group, id: `candidate:${digest(group.sourceIds.slice().sort().join('|')).slice(0, 16)}` }));
    const singleton = sourceId => {
      const p = requests.find(record => record.id === sourceId).problemAnalysis;
      return { id: `${stableProblemId(p)}:${digest(sourceId).slice(0, 6)}`, sourceIds: [sourceId], representativeId: sourceId, label: p.desiredOutcome.length > 95 ? `${p.desiredOutcome.slice(0, 92).replace(/\s+\S*$/, '')}…` : p.desiredOutcome, audience: p.audience, workflow: p.workflow, problem: p.problem, desiredOutcome: p.desiredOutcome, confidence: p.confidence, reviewed: true, inferred: true, reviewMethod: `${PROBLEM_CONTRACT_VERSION}:single-request` };
    };
    const singletons = candidates.filter(group => group.sourceIds.length === 1).map(group => singleton(group.sourceIds[0]));
    const reviewed = await reviewProblems(candidates.filter(group => group.sourceIds.length > 1), understood.records, cache, reasoner, onProgress, options);
    const recordMap = new Map(understood.records.map(record => [record.id, record]));
    const now = new Date();
    const combined = new Map();
    for (const group of [...singletons, ...reviewed.groups]) {
      const previous = combined.get(group.id);
      combined.set(group.id, previous ? { ...previous, sourceIds: [...new Set([...previous.sourceIds, ...group.sourceIds])] } : group);
    }
    // Revisit nearby meanings across the first review's batch boundaries. This
    // avoids treating equivalent asks as separate markets merely due to ordering.
    const initialGroups = [...combined.values()];
    const groupTexts = initialGroups.map(p => `${p.workflow}. ${p.problem}. Desired outcome: ${p.desiredOutcome}`);
    const groupVectors = groupTexts.length ? await (options.embed || embedTexts)(groupTexts, directory, onProgress) : [];
    const neighborhoods = problemNeighborhoods(initialGroups, groupVectors);
    const consolidated = await reviewProblems(neighborhoods, understood.records, cache, reasoner, value => onProgress({ ...value, phase: 'consolidating' }), options);
    const revisited = new Set(neighborhoods.flatMap(group => group.sourceIds));
    const preliminary = [...initialGroups.filter(group => !group.sourceIds.some(id => revisited.has(id))), ...consolidated.groups];
    // A failed or incomplete review must not silently lose validated asks.
    const assigned = new Set(preliminary.flatMap(group => group.sourceIds));
    const exclusions = new Map([...reviewed.excluded, ...consolidated.excluded].map(row => [row.sourceId, row]));
    const excluded = new Set(exclusions.keys());
    for (const record of requests) if (!assigned.has(record.id) && !excluded.has(record.id)) preliminary.push(singleton(record.id));
    for (const record of understood.records) {
      const decision = exclusions.get(record.id);
      record.reviewDecision = decision ? { status: 'excluded', reason: decision.reason, version: PROBLEM_CONTRACT_VERSION, reviewedAt: now.toISOString() } : null;
      record.request = requestFor(record);
    }
    const eligibleRequests = requestRecords(understood.records);
    const globalEnabled = options.globalJobs === undefined ? reasoner.compact === true : options.globalJobs === true;
    let global = { groups: [], errors: [], audits: [] }, globalVersion = null;
    if (globalEnabled) {
      const { discoverGlobalJobs, GLOBAL_JOBS_VERSION } = await import('./global-jobs.mjs');
      globalVersion = GLOBAL_JOBS_VERSION;
      try {
        global = await discoverGlobalJobs(eligibleRequests, cache, reasoner, options.embed || embedTexts, onProgress, {
          ...options, directory, now, requestVectors: new Map(requests.map((record, index) => [record.id, vectors[index]])),
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        global.errors.push(`Global discovery: ${error.message}`);
      }
    }
    const globalMembers = new Set(global.groups.flatMap(group => group.sourceIds));
    const globalIdentities = new Set(global.groups.map(group => group.id));
    const regrouped = preliminary.flatMap(group => {
      const sourceIds = group.sourceIds.filter(id => !excluded.has(id) && !globalMembers.has(id));
      // An unmatched local member must not rejoin a global hypothesis that
      // declined it merely because a prior review used the same canonical ID.
      if (globalIdentities.has(group.id)) return sourceIds.map(singleton);
      return sourceIds.length ? [{ ...group, sourceIds }] : [];
    });
    // Consolidation can rename a neighborhood to an existing, unrevisited
    // problem. Merge before auditing so the combined demand is checked together.
    const uniqueProblems = new Map();
    for (const group of [...regrouped, ...global.groups]) {
      const sourceIds = [...new Set(group.sourceIds)].filter(id => !excluded.has(id));
      if (!sourceIds.length) continue;
      const previous = uniqueProblems.get(group.id);
      uniqueProblems.set(group.id, previous ? { ...previous, sourceIds: [...new Set([...previous.sourceIds, ...sourceIds])] } : { ...group, sourceIds });
    }
    const { auditGroups } = await import('./audit.mjs');
    const audited = await auditGroups([...uniqueProblems.values()], understood.records, cache, reasoner, onProgress, { ...options, now, minAccounts: options.minAccounts ?? (reasoner.compact === true ? 2 : 10) });
    const reviewedMemberships = reviewMemberships([...audited.groups, ...audited.ungroupedIds.filter(id => !excluded.has(id)).map(singleton)], understood.records);
    const retainedMembers = new Set(reviewedMemberships.groups.flatMap(group => group.sourceIds));
    const finalGroups = [...reviewedMemberships.groups, ...reviewedMemberships.rejectedIds.filter(id => !excluded.has(id) && !retainedMembers.has(id)).map(singleton)];
    const signals = finalGroups.map(group => ({ ...group, ...summarizeSignal(group, recordMap, now), label: group.label })).filter(signal => signal.allTimeCount > 0).sort((a, b) => b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount || b.allTimeCount - a.allTimeCount || b.platforms.length - a.platforms.length);
    const memberships = new Map(signals.flatMap(signal => signal.sourceIds.map(id => [id, signal.id])));
    for (const record of understood.records) record.signalId = memberships.get(record.id) || null;
    const errors = [...understood.errors, ...reviewed.errors, ...consolidated.errors, ...global.errors, ...audited.errors];
    const publishedGlobal = signals.filter(group => globalIdentities.has(group.id));
    const globalStats = { enabled: globalEnabled, version: globalVersion, acceptedGroups: global.groups.length, publishedGroups: publishedGlobal.length, assignedRequests: new Set(publishedGlobal.flatMap(group => group.sourceIds)).size, auditDecisions: global.audits.length, errors: global.errors.length };
    return { ...corpus, records: understood.records, signals, membershipAudits: [...global.audits, ...audited.audits, ...reviewedMemberships.audits], analysis: { method: 'problem-understanding-and-review', model: 'gpt-6-luna', embeddingModel: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, generatedAt: now.toISOString(), candidateCount: understood.candidates, analyzedCount: understood.analyzed, pendingCount: understood.pending, requestCount: eligibleRequests.length, groupedRequestCount: memberships.size, distinctAuthors: new Set(eligibleRequests.map(requesterKey)).size, signalCount: signals.length, auditedGroups: new Set(signals.filter(group => ['verified', 'partial'].includes(group.audit?.status)).map(group => group.id)).size, globalJobs: globalStats, evidenceReviews: { version: reviewedQuotes.stats.version, quotes: reviewedQuotes.stats, memberships: reviewedMemberships.stats }, thresholds: [10, 20, 50], windowDays: 365, classification: 'quote-validated-model-analysis', status: understood.pending || errors.length || reviewed.rejected.length || consolidated.rejected.length ? 'partial' : 'ready', validationRejects: understood.rejected.length + reviewed.rejected.length + consolidated.rejected.length, errors, fingerprint: digest(understood.records.map(r => `${r.id}:${r.text}`).join('\n')) } };
  } finally { if (!options.reasoner) reasoner.close(); }
}

export function problemNeighborhoods(groups, vectors) {
  const byId = new Map(groups.map(group => [group.id, group]));
  return clusterRequests(groups, vectors, { threshold: .62, minAnchorSimilarity: .48 })
    .filter(neighborhood => neighborhood.sourceIds.length > 1)
    .map(neighborhood => {
      const sourceIds = [...new Set(neighborhood.sourceIds.flatMap(id => byId.get(id).sourceIds))];
      return { id: `consolidate:${digest(sourceIds.slice().sort().join('|')).slice(0, 16)}`, sourceIds };
    });
}

export function searchSignals(corpus, query = '', topicId = '', limit = 16) {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const records = new Map(corpus.records.map(record => [record.id, record]));
  return (corpus.signals || []).filter(signal => signal.allTimeCount > 0 && (!topicId || signal.topicId === topicId)).map(signal => {
    const text = `${signal.label} ${signal.workflow || ''} ${signal.problem || ''} ${signal.desiredOutcome || ''} ${signal.sourceIds.map(id => records.get(id)?.request?.quote || '').join(' ')}`.toLowerCase();
    return { ...signal, matchScore: terms.filter(term => text.includes(term)).length };
  }).filter(signal => !terms.length || signal.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore || b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount || b.threadCount - a.threadCount).slice(0, limit);
}

export function recountSignals(corpus) {
  const records = corpus.records.map(source => ({ ...source, request: requestFor(source) }));
  const map = new Map(records.map(record => [record.id, record]));
  const signals = (corpus.signals || []).map(group => {
    const summary = summarizeSignal(group, map);
    return summary ? { ...group, ...summary, label: group.reviewed ? group.label : summary.label } : null;
  }).filter(signal => signal && signal.allTimeCount > 0).sort((a, b) => b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount);
  const memberships = new Map(signals.flatMap(signal => signal.sourceIds.map(id => [id, signal.id])));
  for (const record of records) record.signalId = memberships.get(record.id) || null;
  const requests = requestRecords(records);
  return { ...corpus, records, signals, analysis: corpus.analysis ? { ...corpus.analysis, generatedAt: new Date().toISOString(), requestCount: requests.length, groupedRequestCount: memberships.size, distinctAuthors: new Set(requests.map(requesterKey)).size, signalCount: signals.length, fingerprint: digest(records.map(r => `${r.id}:${r.text}`).join('\n')) } : undefined };
}
