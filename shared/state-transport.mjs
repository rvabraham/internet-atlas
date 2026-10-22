import { sourceVisible } from './source-visibility.mjs';

const corpusViews = new WeakMap();

function visibilityManifest(corpus) {
  const records = corpus.records || [], groups = corpus.signals || [];
  const values = [records.length, groups.length, corpus.fetchedAt, corpus.analysis, corpus.analysis?.generatedAt];
  for (const record of records) values.push(record, record.id, sourceVisible(record), record.title, record.text, record.author, record.authorId, record.url, record.date, record.fetchedAt, record.status, record.request, record.problemAnalysis, record.reviewDecision);
  for (const group of groups) {
    values.push(group, group.id, group.representativeId, group.label, group.workflow, group.problem, group.desiredOutcome, group.requesterCount, group.allTimeCount, group.sourceIds?.length ?? 0);
    for (const id of group.sourceIds || []) values.push(id);
  }
  return values;
}

/** Browser evidence excludes raw scraper markup and per-member audit diagnostics. */
export function browserCorpus(corpus) {
  const manifest = visibilityManifest(corpus), cached = corpusViews.get(corpus);
  if (cached && manifest.length === cached.manifest.length && manifest.every((value, index) => Object.is(value, cached.manifest[index]))) return cached.visible;
  const { membershipAudits, records, ...metadata } = corpus;
  const publicRecords = records.filter(sourceVisible).map(({ originalHtml, ...record }) => record);
  const known = new Set(publicRecords.map(record => record.id));
  const signals = corpus.signals?.flatMap(group => {
    const sourceIds = (group.sourceIds || []).filter(id => known.has(id));
    return sourceIds.length ? [{ ...group, sourceIds, ...(group.representativeId && !known.has(group.representativeId) ? { representativeId: sourceIds[0] } : {}) }] : [];
  });
  const visible = { ...metadata, records: publicRecords, ...(signals ? { signals } : {}) };
  corpusViews.set(corpus, { manifest, visible });
  return visible;
}

/** Each SSE client receives a full bootstrap; subsequent shared updates reuse its corpus. */
export function createStateBroadcaster(initialCorpusIdentity) {
  let previous = initialCorpusIdentity;
  let previousView = initialCorpusIdentity ? browserCorpus(initialCorpusIdentity) : undefined;
  return (state, corpusIdentity = state.corpus) => {
    if (!Object.hasOwn(state, 'corpus')) return state;
    const view = corpusIdentity ? browserCorpus(corpusIdentity) : state.corpus;
    if (corpusIdentity === previous && view === previousView) { const { corpus, ...patch } = state; return patch; }
    previous = corpusIdentity; previousView = view;
    return { ...state, corpus: view };
  };
}

/** Buffers early patches and prevents an older GET response overwriting live SSE state. */
export function createStateReceiver() {
  let current = null, pending = {};
  const merge = (base, patch) => ({ ...base, ...patch, corpus: patch.corpus ?? base.corpus });
  return {
    receive(patch) {
      if (!patch || typeof patch !== 'object') return current;
      if (current) current = merge(current, patch);
      else if (patch.corpus) { current = merge(pending, patch); pending = {}; }
      else pending = { ...pending, ...patch };
      return current;
    },
    initialize(snapshot) {
      if (!current) { current = merge(snapshot, pending); pending = {}; }
      return current;
    },
  };
}
