const text = (value, length) => String(value || '').trim().slice(0, length);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Saved problems own evidence references independently of pins and the active idea. */
export function shortlistSourceIds(shortlists = []) {
  const entries = Array.isArray(shortlists) ? shortlists : [];
  return [...new Set(entries.filter(entry => entry && typeof entry.problemId === 'string').flatMap(entry => Array.isArray(entry.sourceIds) ? entry.sourceIds.filter(id => typeof id === 'string' && id) : []))];
}

/** Explicit saved=true/false is idempotent and avoids read-modify-toggle races. */
export function updateShortlists(current = [], input, corpus, now = new Date()) {
  if (!input || typeof input.problemId !== 'string' || !input.problemId.trim() || typeof input.saved !== 'boolean') throw new Error('Choose a problem and whether to save it.');
  const problemId = input.problemId;
  const existing = Array.isArray(current) ? current.filter(entry => entry && typeof entry.problemId === 'string') : [];
  const without = existing.filter(entry => entry.problemId !== problemId);
  if (!input.saved) return without;
  const group = (corpus?.signals || []).find(group => group.id === problemId);
  if (!group || !group.reviewed) throw new Error('Save a reviewed problem from the atlas.');
  if (!Array.isArray(group.sourceIds)) throw new Error('This problem has no source evidence.');
  const known = new Set((corpus.records || []).map(record => record.id));
  const sourceIds = [...new Set(group.sourceIds)].filter(id => typeof id === 'string' && known.has(id));
  if (!sourceIds.length) throw new Error('This problem has no source evidence.');
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const previous = existing.find(entry => entry.problemId === problemId);
  const entry = {
    problemId, label: text(group.label, 180), audience: text(group.audience, 180),
    workflow: text(group.workflow, 220), problem: text(group.problem, 350), desiredOutcome: text(group.desiredOutcome, 350),
    sourceIds, savedAt: validDate(previous?.savedAt) ? previous.savedAt : timestamp,
    requesterCount: Math.max(0, Number.isFinite(group.requesterCount) ? group.requesterCount : 0),
    allTimeCount: Math.max(0, Number.isFinite(group.allTimeCount) ? group.allTimeCount : 0),
    asOf: validDate(group.asOf) ? group.asOf : timestamp,
  };
  if (!entry.label) throw new Error('This problem needs a label before it can be saved.');
  if (without.length >= 200) throw new Error('Saved problems are limited to 200.');
  // Updating a saved item preserves its position and original save date.
  return previous ? existing.map(saved => saved.problemId === problemId ? entry : saved).filter((saved, index, all) => all.findIndex(other => other.problemId === saved.problemId) === index) : [entry, ...without];
}
