import { PROBLEM_CONTRACT_VERSION, problemCacheKey, sourceContentHash, validateExtractions, EXTRACTION_SCHEMA } from './problems.mjs';

// V2 only narrows the eligible scope. V1 exclusions remain exclusions, but every
// previous positive must be reclassified. Never reuse an entry for edited content.
export function reuseNarrowedNonrequests(records, cache, model = 'gpt-6-luna') {
  if (PROBLEM_CONTRACT_VERSION !== 'problem-understanding-v2') return 0;
  const byHash = new Map(Object.values(cache.data.extractions).filter(row => row.contractVersion === 'problem-understanding-v1' && row.model === model && row.classification !== 'request').map(row => [row.contentHash, row]));
  const fields = Object.keys(EXTRACTION_SCHEMA.properties.extractions.items.properties);
  const identity = { provider: 'codex-subscription', model, modelRevision: model, promptVersion: PROBLEM_CONTRACT_VERSION };
  let reused = 0;
  for (const record of records) {
    const key = problemCacheKey(record, identity);
    if (cache.data.extractions[key]) continue;
    const previous = byHash.get(sourceContentHash(record));
    if (!previous) continue;
    const checked = validateExtractions({ extractions: [Object.fromEntries(fields.map(field => [field, previous[field]]))] }, [record]);
    if (!checked.accepted.length) continue;
    cache.data.extractions[key] = { ...checked.accepted[0], model, analyzedAt: previous.analyzedAt, reusedFromContract: 'problem-understanding-v1', reuseReason: 'The software-only scope is a strict narrowing. Existing exclusions remain excluded.' };
    reused++;
  }
  return reused;
}
