import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_REVISION } from './signals.mjs';
import { attributableSource, requestFor } from './requests.mjs';

export const NODE_SEARCH_VERSION = 'graph-node-search-v1';
export const NODE_SEARCH_MIN_SIMILARITY = .28;
export const NODE_NEIGHBOR_MIN_SIMILARITY = .35;
const QUERY_CACHE_LIMIT = 128;
const SEARCH_RELATIVE_MARGIN = .18;
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const meaning = value => `${normalize(value.workflow)}. ${normalize(value.problem)}. Desired outcome: ${normalize(value.desiredOutcome)}`;
const hasMeaning = value => value && ['workflow', 'problem', 'desiredOutcome'].every(key => normalize(value[key]));
const bound = limit => Math.min(80, Math.max(1, Math.floor(Number(limit)) || 40));
const stopwords = new Set('a an and are as at be by for from how i in is it me my of on or our that the their there these this to was we what when where which with would you your ai app apps software tool tools product products feature request requests people users user'.split(' '));
const termsFor = query => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].filter(term => !stopwords.has(term));
const embeddingQueues = new Map();

function unitVector(value) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || !value.length || [...value].some(number => typeof number !== 'number' || !Number.isFinite(number))) throw new Error('Node search received an invalid embedding.');
  const norm = Math.sqrt([...value].reduce((sum, number) => sum + number * number, 0));
  if (!norm) throw new Error('Node search received an empty embedding.');
  return [...value].map(number => number / norm);
}
function cosine(a, b) {
  if (a.length !== b.length) throw new Error('Node search received incompatible embeddings.');
  let dot = 0; for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return Math.max(-1, Math.min(1, dot));
}
function decodeVector(value) {
  if (typeof value !== 'string') throw new Error('Invalid cached node vector.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length % 4) throw new Error('Invalid cached node vector.');
  return unitVector(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
}
const encodeVector = value => Buffer.from(new Float32Array(value).buffer).toString('base64');
function lexicalScore(document, query, terms, phrasePattern, minimumTerms) {
  if (document.id.toLowerCase() === query) return 1;
  const matches = terms.filter(term => document.lexical.includes(term)).length;
  const coverage = terms.length ? matches / terms.length : 0;
  const phrase = query.length >= 2 && phrasePattern.test(document.lexical);
  if (!phrase && (matches < minimumTerms || coverage < .6)) return 0;
  return Math.min(1, coverage * .7 + (phrase ? .3 : 0));
}

function snapshot(corpus) {
  const records = (corpus?.records || []).filter(record => typeof record.id === 'string' && attributableSource(record));
  const sources = new Map(records.map(record => [record.id, record])), documents = new Map();
  const add = document => {
    if (!document.text || documents.has(document.id)) return;
    document.key = hash(JSON.stringify([NODE_SEARCH_VERSION, EMBEDDING_MODEL, EMBEDDING_REVISION, document.kind, document.id, document.text]));
    document.lexical = normalize(document.lexical).toLowerCase();
    documents.set(document.id, document);
  };
  for (const record of records) {
    const raw = normalize(`${record.title || ''}\n${record.text || ''}`).slice(0, 900);
    const positive = requestFor(record) && hasMeaning(record.problemAnalysis);
    const text = positive ? meaning(record.problemAnalysis) : normalize(`${record.title || ''}\n${String(record.text || '').slice(0, 320)}`).slice(0, 520);
    add({ id: record.id, kind: 'source', sourceIds: [record.id], topics: [record.topicId].filter(Boolean), platforms: [record.source].filter(Boolean), text, lexical: `${record.id} ${record.author || ''} ${raw} ${text}` });
  }
  for (const group of corpus?.signals || []) {
    if (!group.reviewed || group.audit?.status === 'failed' || !hasMeaning(group) || typeof group.id !== 'string') continue;
    const members = [...new Set(group.sourceIds || [])].map(id => sources.get(id)).filter(record => record && requestFor(record));
    if (!members.length) continue;
    const text = meaning(group);
    add({ id: group.id, kind: 'problem', sourceIds: members.map(record => record.id), topics: [...new Set([group.topicId, ...members.map(record => record.topicId)].filter(Boolean))], platforms: [...new Set(members.map(record => record.source).filter(Boolean))], text, lexical: `${group.id} ${group.label || ''} ${text}` });
  }
  const nodes = [...documents.values()].sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = hash(JSON.stringify(nodes.map(node => [node.key, node.sourceIds, node.topics, node.platforms, node.lexical])));
  return { nodes, fingerprint };
}

/** Compare primitive inputs before normalizing full source text or hashing nodes. */
export function createNodeSnapshotCache(getCorpus) {
  let previous = null, cached = null;
  return () => {
    const corpus = getCorpus(), records = corpus?.records || [], groups = corpus?.signals || [];
    const manifest = [records.length, groups.length];
    for (const record of records) {
      const p = record.problemAnalysis;
      manifest.push(record.id, record.title, record.text, record.author, record.authorId, record.source, record.topicId, record.date,
        record.status, attributableSource(record), record.recordType, Object.hasOwn(record, 'problemAnalysis'), Boolean(p),
        p?.classification, p?.confidence, p?.requesterRole, p?.evidenceQuote, p?.workflow, p?.problem, p?.desiredOutcome,
        record.reviewDecision?.status, record.labels?.length ?? -1);
      for (const label of record.labels || []) manifest.push(label);
    }
    for (const group of groups) {
      manifest.push(group.id, group.reviewed, group.audit?.status, group.label, group.workflow, group.problem, group.desiredOutcome, group.topicId, group.sourceIds?.length ?? 0);
      for (const id of group.sourceIds || []) manifest.push(id);
    }
    if (previous && previous.length === manifest.length && manifest.every((value, index) => Object.is(value, previous[index]))) return cached;
    // Compare the complete raw strings above. Clipping before this boundary
    // could miss a removed quote or privacy-relevant edit beyond the preview.
    cached = snapshot(corpus); previous = manifest;
    return cached;
  };
}

/** Retrieval relations are navigation hints. This index never changes demand membership or counts. */
export function createNodeSearch({ getCorpus, directory, embed = embedTexts, onProgress = () => {} }) {
  if (typeof getCorpus !== 'function' || typeof directory !== 'string' || typeof embed !== 'function') throw new Error('Node search needs a corpus getter, directory and embedding function.');
  const cacheDirectory = resolve(directory, 'node-search'), cachePath = resolve(cacheDirectory, 'vectors.json');
  const currentSnapshot = createNodeSnapshotCache(getCorpus);
  let index = null, pending = null, cacheLoaded = null, vectorCache = {}, failedFingerprint = null, buildingFingerprint = null;
  let state = 'idle', nodeCount = 0, indexedCount = 0, lastError = null;
  const queries = new Map();
  const info = () => {
    const current = currentSnapshot(), ready = index?.fingerprint === current.fingerprint;
    const building = buildingFingerprint === current.fingerprint, failed = failedFingerprint === current.fingerprint;
    return { state: ready ? current.nodes.length ? 'ready' : 'empty' : building ? 'indexing' : failed ? 'degraded' : current.nodes.length ? 'idle' : 'empty', nodeCount: current.nodes.length,
      indexedCount: ready ? index.nodes.length : building ? indexedCount : 0, model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION,
      ...(lastError && (ready || failed) ? { error: lastError } : {}) };
  };
  const emit = detail => onProgress({ ...detail, phase: 'node-search', state, nodeCount, indexedCount });
  const loadCache = () => cacheLoaded ||= (async () => {
    try {
      const saved = JSON.parse(await readFile(cachePath, 'utf8'));
      if (saved.version === NODE_SEARCH_VERSION && saved.model === EMBEDDING_MODEL && saved.revision === EMBEDDING_REVISION && plain(saved.vectors)) vectorCache = saved.vectors;
    } catch { /* A missing or invalid cache is rebuilt locally. */ }
  })();
  const embedding = (texts, progress = () => {}, persist = true) => {
    // embedTexts persists embeddings.json, so serialize builds and queries at
    // this dedicated path, including across two consumers in the same process.
    const task = (embeddingQueues.get(cacheDirectory) || Promise.resolve()).catch(() => {}).then(async () => {
      const output = await embed(texts, cacheDirectory, progress, { persist });
      if (!Array.isArray(output) || output.length !== texts.length) throw new Error('Node search received incomplete embeddings.');
      const vectors = output.map(unitVector);
      if (vectors.some(vector => vector.length !== vectors[0].length)) throw new Error('Node search received incompatible embeddings.');
      return vectors;
    });
    embeddingQueues.set(cacheDirectory, task);
    task.finally(() => { if (embeddingQueues.get(cacheDirectory) === task) embeddingQueues.delete(cacheDirectory); }).catch(() => {});
    return task;
  };
  async function build(target) {
    buildingFingerprint = target.fingerprint;
    state = 'indexing'; nodeCount = target.nodes.length; indexedCount = 0; lastError = null;
    emit({ completed: 0, total: nodeCount });
    await loadCache();
    const vectors = new Map(), missing = [];
    let dimensions;
    for (const node of target.nodes) {
      try {
        const vector = decodeVector(vectorCache[node.key]);
        dimensions ??= vector.length;
        if (vector.length !== dimensions) throw new Error('Inconsistent cached dimensions.');
        vectors.set(node.id, vector);
      } catch { missing.push(node); }
    }
    indexedCount = vectors.size;
    if (missing.length) {
      // embedTexts performs its own small inference batches and one atomic cache
      // save. Passing all missing texts avoids repeatedly rewriting that cache.
      const output = await embedding(missing.map(node => node.text), progress => {
        indexedCount = vectors.size + Math.min(missing.length, Number(progress.completed) || 0);
        emit({ completed: indexedCount, total: nodeCount });
      });
      if (dimensions && output[0].length !== dimensions) throw new Error('Node search cache dimensions differ from its model.');
      missing.forEach((node, position) => vectors.set(node.id, output[position]));
    }
    const keys = new Set(target.nodes.map(node => node.key));
    const oldKeys = Object.keys(vectorCache);
    if (missing.length || oldKeys.length !== keys.size || oldKeys.some(key => !keys.has(key))) {
      const missingIds = new Set(missing.map(node => node.id));
      const savedVectors = Object.fromEntries(target.nodes.map(node => [node.key, missingIds.has(node.id) ? encodeVector(vectors.get(node.id)) : vectorCache[node.key]]));
      await mkdir(cacheDirectory, { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: NODE_SEARCH_VERSION, model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, vectors: savedVectors }));
      await rename(temporary, cachePath);
      vectorCache = savedVectors;
    }
    index = { ...target, byId: new Map(target.nodes.map(node => [node.id, node])), vectors };
    indexedCount = nodeCount; state = nodeCount ? 'ready' : 'empty'; lastError = null; failedFingerprint = null;
    emit({ completed: indexedCount, total: nodeCount });
  }
  async function ensureIndex() {
    while (true) {
      const target = currentSnapshot();
      if (index?.fingerprint === target.fingerprint) return index;
      if (failedFingerprint === target.fingerprint) return null;
      if (!pending) {
        pending = build(target).catch(error => {
          failedFingerprint = target.fingerprint; state = 'degraded'; lastError = String(error.message || error).slice(0, 300);
          emit({ completed: indexedCount, total: nodeCount });
        }).finally(() => { pending = null; buildingFingerprint = null; });
      }
      await pending;
      // A corpus replaced while embedding must not publish stale or newly
      // private sources. Recheck the current manifest before returning results.
    }
  }
  async function queryVector(query) {
    if (queries.has(query)) {
      const promise = queries.get(query); queries.delete(query); queries.set(query, promise); return promise;
    }
    // Interactive queries use the bounded memory cache above. Do not load or
    // rewrite the full corpus embedding cache for every new search phrase.
    const promise = embedding([query], undefined, false).then(vectors => vectors[0]);
    queries.set(query, promise);
    while (queries.size > QUERY_CACHE_LIMIT) queries.delete(queries.keys().next().value);
    promise.catch(() => { if (queries.get(query) === promise) queries.delete(query); });
    return promise;
  }
  function response(nodes, query, vector, { topicId = '', limit = 40, sourceFilters = [] } = {}, excludedId = null, minSimilarity = NODE_SEARCH_MIN_SIMILARITY) {
    const terms = termsFor(query), filters = new Set(Array.isArray(sourceFilters) ? sourceFilters : []);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const phrasePattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u');
    const minimumTerms = (query.match(/[\p{L}\p{N}]{2,}/gu) || []).length === 1 ? 1 : 2;
    const results = []; let bestSemantic = minSimilarity;
    for (const node of nodes) {
      if (node.id === excludedId || topicId && !node.topics.includes(topicId) || filters.size && !node.platforms.some(source => filters.has(source))) continue;
      const lexical = lexicalScore(node, query, terms, phrasePattern, minimumTerms);
      const semantic = vector && index?.vectors.has(node.id) ? cosine(vector, index.vectors.get(node.id)) : null;
      if (semantic !== null ? semantic < minSimilarity && (excludedId || !lexical) : !lexical) continue;
      if (semantic !== null) bestSemantic = Math.max(bestSemantic, semantic);
      const score = semantic === null ? lexical : excludedId ? Math.max(0, semantic) : Math.max(Math.max(0, semantic) * .8 + lexical * .2, lexical * .9);
      results.push({ node, lexical, semantic, score: Math.round(score * 1e6) / 1e6 });
    }
    const relativeCutoff = Math.max(minSimilarity, bestSemantic - SEARCH_RELATIVE_MARGIN);
    return results.filter(row => excludedId || row.semantic === null || row.semantic >= relativeCutoff || row.lexical)
      .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, bound(limit))
      .map(({ node, score }) => ({ id: node.id, kind: node.kind, sourceIds: node.sourceIds.slice(), score }));
  }
  async function search(value, options = {}) {
    const query = normalize(value).slice(0, 500).toLowerCase();
    if (!query) return { results: [], method: 'none', state: state === 'idle' ? 'empty' : state };
    let ready = await ensureIndex(), vector;
    if (ready?.nodes.length) {
      try { vector = await queryVector(query); }
      catch (error) { lastError = String(error.message || error).slice(0, 300); }
      ready = await ensureIndex();
    }
    const nodes = ready?.nodes || currentSnapshot().nodes;
    try { return { results: response(nodes, query, ready ? vector : null, options), method: vector && ready ? 'hybrid' : 'keyword', state: !nodes.length ? 'empty' : ready && vector ? 'ready' : 'degraded' }; }
    catch (error) {
      lastError = String(error.message || error).slice(0, 300);
      return { results: response(nodes, query, null, options), method: 'keyword', state: nodes.length ? 'degraded' : 'empty' };
    }
  }
  async function neighbors(id, options = {}) {
    const ready = await ensureIndex(), nodes = ready?.nodes || currentSnapshot().nodes;
    const node = nodes.find(item => item.id === id);
    if (!node) return { results: [], method: 'none', state: nodes.length ? ready ? 'ready' : 'degraded' : 'empty' };
    const vector = ready?.vectors.get(id);
    return { results: response(nodes, node.text.toLowerCase(), vector, options, id, NODE_NEIGHBOR_MIN_SIMILARITY), method: vector ? 'semantic' : 'keyword', state: ready ? 'ready' : 'degraded' };
  }
  async function prewarm() {
    // Explicit prewarming is also the retry boundary after a model/cache error.
    failedFingerprint = null;
    await ensureIndex(); return info();
  }
  return { search, neighbors, info, prewarm };
}
