import { searchRecords } from './data.mjs';
import { attributableSource } from './requests.mjs';

export function nodeSearchResponse(found, info, query = '') {
  return { ...found, query, status: found.state, indexed: info.indexedCount, total: info.nodeCount };
}

/** Immediate literal matches remain usable during a cold local index build. */
export function pendingNodeSearch(corpus, query, { topicId = '', sourceFilters = [], limit = 60 } = {}) {
  const records = corpus.records.filter(record => attributableSource(record) && (!sourceFilters.length || sourceFilters.includes(record.source)));
  return { method: 'keyword', state: 'indexing', results: searchRecords({ ...corpus, records }, query, limit, topicId || undefined).map(record => ({ id: record.id, kind: 'source', sourceIds: [record.id], score: record.score })) };
}
