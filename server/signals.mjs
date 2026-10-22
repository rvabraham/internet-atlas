import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { detectRequest, priorityTier } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const digest = text => createHash('sha256').update(text).digest('hex');
const requesterKey = record => ['github', 'reddit', 'x'].includes(record.source) ? record.authorId.toLowerCase() : record.authorId;
export const cosine = (a, b) => { let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; return dot; };
const normalize = vector => { const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1; return vector.map(x => x / norm); };

export function requestRecords(records) {
  const urls = new Set(), copies = new Set(), selected = [];
  for (const source of records) {
    const request = detectRequest(source);
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
export async function embedTexts(texts, directory, onProgress = () => {}) {
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
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* First local indexing. */ }
  const keys = texts.map(text => digest(`${EMBEDDING_MODEL}:${EMBEDDING_REVISION}:q8:v1:${text}`));
  const missing = [...new Set(keys)].filter(key => !cache[key]);
  const textForKey = new Map(keys.map((key, i) => [key, texts[i]]));
  for (let offset = 0; offset < missing.length; offset += 16) {
    const batchKeys = missing.slice(offset, offset + 16);
    const tensor = await extractor(batchKeys.map(key => textForKey.get(key)), { pooling: 'mean', normalize: true });
    const output = tensor.tolist(); batchKeys.forEach((key, i) => { cache[key] = output[i]; });
    onProgress({ phase: 'embedding', completed: Math.min(offset + 16, missing.length), total: missing.length });
  }
  const temporary = `${cachePath}.tmp`; await writeFile(temporary, JSON.stringify(cache)); await rename(temporary, cachePath);
  return keys.map(key => cache[key]);
}

export async function analyzeCorpus(corpus, directory, onProgress = () => {}) {
  const prepared = corpus.records.map(source => ({ ...source, request: detectRequest(source) }));
  const requests = requestRecords(prepared).sort((a, b) => a.id.localeCompare(b.id));
  const now = new Date();
  onProgress({ phase: 'requests', completed: requests.length, total: prepared.length });
  const texts = requests.map(record => record.recordType === 'comment' ? `${record.request.quote}\n${record.request.quote}\nContext: ${record.title}` : `${record.title}\n${record.title}\n${record.request.quote.slice(0, 650)}`);
  const vectors = requests.length ? await embedTexts(texts, directory, onProgress) : [];
  onProgress({ phase: 'clustering', completed: 0, total: requests.length });
  const groups = clusterRequests(requests, vectors);
  const recordMap = new Map(prepared.map(record => [record.id, record]));
  const signals = groups.map(group => summarizeSignal(group, recordMap, now)).filter(Boolean).sort((a, b) => b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount || b.platforms.length - a.platforms.length);
  const memberships = new Map(signals.flatMap(signal => signal.sourceIds.map(id => [id, signal.id])));
  for (const record of prepared) record.signalId = memberships.get(record.id) || null;
  return { ...corpus, records: prepared, signals, analysis: { method: 'local-semantic-embeddings', model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, generatedAt: now.toISOString(), requestCount: requests.length, distinctAuthors: new Set(requests.map(requesterKey)).size, signalCount: signals.length, thresholds: [10, 20, 50], windowDays: 365, classification: 'explicit-ask-rules', status: 'ready', fingerprint: digest(prepared.map(r => `${r.id}:${r.text}`).join('\n')) } };
}

export function searchSignals(corpus, query = '', topicId = '', limit = 16) {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const records = new Map(corpus.records.map(record => [record.id, record]));
  return (corpus.signals || []).filter(signal => signal.requesterCount > 0 && (!topicId || signal.topicId === topicId)).map(signal => {
    const text = `${signal.label} ${signal.sourceIds.map(id => records.get(id)?.request?.quote || '').join(' ')}`.toLowerCase();
    return { ...signal, matchScore: terms.filter(term => text.includes(term)).length };
  }).filter(signal => !terms.length || signal.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore || b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount || b.threadCount - a.threadCount).slice(0, limit);
}

export function recountSignals(corpus) {
  const records = corpus.records.map(source => ({ ...source, request: detectRequest(source) }));
  const map = new Map(records.map(record => [record.id, record]));
  const signals = (corpus.signals || []).map(group => summarizeSignal(group, map)).filter(signal => signal && signal.allTimeCount > 0).sort((a, b) => b.tier.rank - a.tier.rank || b.requesterCount - a.requesterCount);
  const memberships = new Map(signals.flatMap(signal => signal.sourceIds.map(id => [id, signal.id])));
  for (const record of records) record.signalId = memberships.get(record.id) || null;
  const requests = requestRecords(records);
  return { ...corpus, records, signals, analysis: corpus.analysis ? { ...corpus.analysis, generatedAt: new Date().toISOString(), requestCount: requests.length, distinctAuthors: new Set(requests.map(requesterKey)).size, signalCount: signals.length, fingerprint: digest(records.map(r => `${r.id}:${r.text}`).join('\n')) } : undefined };
}
