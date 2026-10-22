import { sourceVisible } from './source-visibility.mjs';

/** Limit a focused atlas to evidence and the hubs that actually connect it. */
export function discoveryVisibility({ corpus, shortlists = [], selected = null, query = '', searchNodeIds = null, relatedIds = [], referencedIds = [], pulseIds = [], topicId = null, sourceFilters }) {
  const records = corpus.records.filter(sourceVisible);
  const sources = new Map(records.map(source => [source.id, source]));
  const groups = new Map((corpus.signals || []).map(group => [group.id, group]));
  for (const saved of shortlists) if (!groups.has(saved.problemId)) groups.set(saved.problemId, { ...saved, id: saved.problemId });
  const topics = new Set(corpus.topics.map(topic => topic.id));
  const authors = new Map();
  for (const source of records) {
    const ids = authors.get(source.authorId) || [];
    ids.push(source.id); authors.set(source.authorId, ids);
  }
  const allowed = source => (!topicId || source.topicId === topicId) && sourceFilters.includes(source.source);
  const sourceIds = new Set(), visibleIds = new Set(), topicCounts = new Map();
  const addSource = (id, force = false) => {
    const source = sources.get(id);
    if (!source || !force && !allowed(source)) return false;
    sourceIds.add(id); return true;
  };
  const addEvidence = (id, force = false) => {
    if (sources.has(id)) return addSource(id, force);
    const group = groups.get(id);
    if (group) {
      let found = false;
      for (const member of group.sourceIds) if (addSource(member, force)) found = true;
      if (found) visibleIds.add(id);
    } else if (authors.has(id)) {
      for (const member of authors.get(id)) addSource(member, force);
    } else if (topics.has(id)) {
      for (const source of records) if (source.topicId === id) addSource(source.id, force);
    }
  };
  const selection = selected && (sources.has(selected) || groups.has(selected) || authors.has(selected) || topics.has(selected));
  const searching = Boolean(query.trim());
  const focused = Boolean(selection || searching || relatedIds.length);
  if (focused) {
    if (selection) addEvidence(selected);
    else if (searching) {
      if (searchNodeIds !== null) for (const id of searchNodeIds) addEvidence(id);
      else {
        const terms = query.toLowerCase().trim().split(/\s+/);
        for (const source of records) if (terms.every(term => `${source.title} ${source.text} ${source.author}`.toLowerCase().includes(term))) addSource(source.id);
        for (const group of groups.values()) if (terms.every(term => `${group.label} ${group.workflow || ''} ${group.problem || ''} ${group.desiredOutcome || ''}`.toLowerCase().includes(term))) addEvidence(group.id);
      }
    }
    for (const id of relatedIds) addEvidence(id);
  } else {
    for (const source of records) addSource(source.id);
  }
  // Final citations and live reads retain their evidence even across source filters.
  for (const id of [...referencedIds, ...pulseIds]) addEvidence(id, true);
  for (const id of sourceIds) {
    const source = sources.get(id);
    visibleIds.add(id);
    if (source.authorId) visibleIds.add(source.authorId);
    if (source.topicId) {
      visibleIds.add(source.topicId);
      topicCounts.set(source.topicId, (topicCounts.get(source.topicId) || 0) + 1);
    }
  }
  // A group hub may connect visible evidence without pulling in its other members.
  for (const group of groups.values()) if (group.sourceIds.some(id => sourceIds.has(id))) visibleIds.add(group.id);
  return { focused, visibleIds, sourceIds, topicCounts };
}
