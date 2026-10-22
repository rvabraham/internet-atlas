import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { detectRequest, requestFor, attributableSource } from './requests.mjs';
import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA, PROBLEM_CONTRACT_VERSION, problemCacheKey, buildExtractionPrompt, validateExtractions, buildGroupReviewPrompt, validateGroupReview } from './problems.mjs';
import { COMPACT_EXTRACTION_SCHEMA, COMPACT_GROUP_REVIEW_SCHEMA, buildCompactExtractionPrompt, normalizeCompactExtractions, buildCompactGroupReviewPrompt, normalizeCompactGroupReview } from './compact.mjs';
import { reuseNarrowedNonrequests } from './cache-migration.mjs';

export const REASONING_MODEL = 'gpt-6-luna';
const identity = { provider: 'codex-subscription', model: REASONING_MODEL, modelRevision: 'gpt-6-luna', promptVersion: PROBLEM_CONTRACT_VERSION };
const hash = text => createHash('sha256').update(text).digest('hex');
const unavailable = record => !attributableSource(record) || !record.authorId || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > Date.now();

export function analysisCandidates(records) {
  const candidates = records.filter(record => !unavailable(record) && (detectRequest(record) || record.collectionCandidate || ['stackexchange', 'reddit', 'x'].includes(record.source)));
  const byPlatform = [...new Set(candidates.map(record => record.source))].map(source => candidates.filter(record => record.source === source).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)));
  return Array.from({ length: Math.max(0, ...byPlatform.map(rows => rows.length)) }, (_, i) => byPlatform.map(rows => rows[i])).flat().filter(Boolean);
}

export async function createReasoner(directory) {
  const { AtlasAgent } = await import('./agent.mjs');
  const agent = new AtlasAgent({ directory }, () => {});
  await agent.connect();
  return { compact: true, complete: (prompt, schema, options) => agent.completeJSON(prompt, schema, options), close: () => agent.close() };
}

export async function openIntelligenceCache(directory) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'problem-analysis.json');
  let data = { extractions: {}, reviews: {} };
  try { data = { ...data, ...JSON.parse(await readFile(path, 'utf8')) }; } catch { /* First analysis. */ }
  let queue = Promise.resolve();
  return { data, save() {
    const snapshot = JSON.stringify(data);
    queue = queue.catch(() => {}).then(async () => { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, snapshot); await rename(temporary, path); });
    return queue;
  } };
}

export async function understandRequests(corpus, cache, reasoner, progress = () => {}, { maxNewRecords = 2000, batchSize = 20, concurrency = 3, signal } = {}) {
  signal?.throwIfAborted();
  if (reuseNarrowedNonrequests(corpus.records, cache, REASONING_MODEL)) await cache.save();
  const candidates = analysisCandidates(corpus.records);
  const selected = candidates.filter(record => !cache.data.extractions[problemCacheKey(record, identity)]).slice(0, maxNewRecords);
  let completed = candidates.length - candidates.filter(record => !cache.data.extractions[problemCacheKey(record, identity)]).length;
  const errors = [], rejected = [];
  progress({ phase: 'understanding', completed, total: candidates.length });
  const batches = Array.from({ length: Math.ceil(selected.length / batchSize) }, (_, i) => selected.slice(i * batchSize, (i + 1) * batchSize));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (cursor < batches.length) {
      signal?.throwIfAborted();
      const batch = batches[cursor++];
      try {
        const compact = reasoner.compact === true;
        const raw = await reasoner.complete(compact ? buildCompactExtractionPrompt(batch) : buildExtractionPrompt(batch), compact ? COMPACT_EXTRACTION_SCHEMA : EXTRACTION_SCHEMA);
        const output = compact ? normalizeCompactExtractions(raw) : raw;
        signal?.throwIfAborted();
        const checked = validateExtractions(output, batch);
        for (const extraction of checked.accepted) {
          const record = batch.find(record => record.id === extraction.sourceId);
          cache.data.extractions[problemCacheKey(record, identity)] = { ...extraction, model: REASONING_MODEL, analyzedAt: new Date().toISOString() };
        }
        rejected.push(...checked.rejected); completed += checked.accepted.length;
        await cache.save(); progress({ phase: 'understanding', completed, total: candidates.length, rejected: rejected.length });
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(error.message); progress({ phase: 'understanding', completed, total: candidates.length, error: error.message });
        if (errors.length >= 3) throw new Error(`Problem understanding failed: ${error.message}. Completed analysis remains cached.`);
      }
    }
  }));
  const records = corpus.records.map(source => {
    const cached = cache.data.extractions[problemCacheKey(source, identity)];
    // Review decisions belong to one complete indexing run. Re-evaluate them
    // from the current review output instead of suppressing a new analysis.
    const record = { ...source, reviewDecision: null, problemAnalysis: cached || null };
    return { ...record, request: requestFor(record), signalId: null };
  });
  const requests = records.filter(record => record.problemAnalysis?.classification === 'request' && record.problemAnalysis.confidence >= .65 && record.request);
  const analyzed = completed;
  return { records, requests, candidates: candidates.length, analyzed, pending: candidates.length - analyzed, rejected, errors };
}

export function reviewBatches(candidates, maxSources = 45) {
  const batches = []; let current = [], count = 0;
  for (const candidate of candidates) {
    // Large broad candidates are split before semantic review, never counted wholesale.
    const parts = Array.from({ length: Math.ceil(candidate.sourceIds.length / maxSources) }, (_, i) => ({ ...candidate, id: `${candidate.id}:${i}`, sourceIds: candidate.sourceIds.slice(i * maxSources, (i + 1) * maxSources) }));
    for (const part of parts) {
      if (current.length && count + part.sourceIds.length > maxSources) { batches.push(current); current = []; count = 0; }
      current.push(part); count += part.sourceIds.length;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function reviewProblems(candidates, records, cache, reasoner, progress = () => {}, { concurrency = 3, signal } = {}) {
  signal?.throwIfAborted();
  const extractions = records.map(record => record.problemAnalysis).filter(Boolean);
  // Keep large retrieved groups together up to 100 sources so the 50+ tier is reachable.
  // Smaller candidates share a tighter batch to bound unrelated model output.
  const batches = [
    ...candidates.filter(candidate => candidate.sourceIds.length > 45).flatMap(candidate => reviewBatches([candidate], 100)),
    ...reviewBatches(candidates.filter(candidate => candidate.sourceIds.length <= 45)),
  ], groups = [], errors = [], rejected = [], excluded = [];
  let cursor = 0, completed = 0;
  progress({ phase: 'reviewing', completed, total: batches.length });
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (cursor < batches.length) {
      signal?.throwIfAborted();
      const batch = batches[cursor++];
      const ids = new Set(batch.flatMap(group => group.sourceIds));
      const sources = records.filter(record => ids.has(record.id));
      const extracted = extractions.filter(row => ids.has(row.sourceId));
      const compact = reasoner.compact === true;
      const prompt = compact ? buildCompactGroupReviewPrompt(batch, sources, extracted) : buildGroupReviewPrompt(batch, sources, extracted);
      const key = hash(`${JSON.stringify(identity)}:review:${prompt}`);
      try {
        const cached = cache.data.reviews[key];
        const raw = cached || await reasoner.complete(prompt, compact ? COMPACT_GROUP_REVIEW_SCHEMA : GROUP_REVIEW_SCHEMA);
        const output = cached ? cached : compact ? normalizeCompactGroupReview(raw, batch, sources, extracted) : raw;
        signal?.throwIfAborted();
        const checked = validateGroupReview(output, batch, sources, extracted);
        groups.push(...checked.accepted.filter(group => group.confidence >= .65)); rejected.push(...checked.rejected); excluded.push(...checked.excluded);
        cache.data.reviews[key] = output; await cache.save();
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(error.message);
        if (errors.length >= 3) throw new Error(`Problem grouping failed: ${error.message}. Completed analysis remains cached.`);
      }
      completed++; progress({ phase: 'reviewing', completed, total: batches.length, rejected: rejected.length });
    }
  }));
  // Identical normalized problems may recur across review batches. Deduplicate their evidence.
  const merged = new Map();
  for (const group of groups) {
    const existing = merged.get(group.id);
    if (existing) existing.sourceIds = [...new Set([...existing.sourceIds, ...group.sourceIds])];
    else merged.set(group.id, { ...group });
  }
  return { groups: [...merged.values()], errors, rejected, excluded };
}
