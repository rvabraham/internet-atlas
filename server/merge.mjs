import { createHash } from 'node:crypto';
import { canonicalSourceUrl } from '../shared/citations.mjs';

const HOSTS = {
  hn: ['news.ycombinator.com'], github: ['github.com'],
  reddit: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  stackexchange: ['softwarerecs.stackexchange.com'], linkedin: ['linkedin.com', 'www.linkedin.com'],
};
const UNAVAILABLE = new Set(['deleted', 'removed', 'closed', 'resolved']);
const PRIVATE_STATUSES = new Set(['redacted', 'unavailable', 'private', 'withdrawn', 'opted-out']);
const DERIVED_RECORD_FIELDS = ['problemAnalysis', 'request', 'signalId', 'signalIds', 'problemIds', 'problemKey', 'clusterId', 'embedding', 'vector', 'requesterCount', 'allTimeCount', 'recentCount', 'score'];
const DERIVED_CORPUS_FIELDS = ['analysis', 'signals', 'membershipAudits', 'problems', 'problemGroups', 'clusters', 'memberships', 'counts', 'stats', 'signalCount', 'requestCount', 'requesterCount', 'embeddings', 'vectors', 'leads', 'leadSearch'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const unique = values => [...new Map(values.filter(value => value !== undefined && value !== null).map(value => [stable(value), value])).values()];
const isTrue = value => value === true || /^(?:true|1|yes)$/i.test(String(value));
const liveVerified = record => Object.hasOwn(record, 'liveVerified') ? record.liveVerified === true : record.dataset?.liveVerified === true;

function publicUrl(value, source, field = 'url') {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an original HTTPS platform URL`); }
  if (url.protocol !== 'https:' || !HOSTS[source]?.includes(url.hostname) || url.username || url.password || url.port) throw new Error(`${field} does not match the HTTPS source platform`);
  return url;
}

// Platform IDs remove slugs and tracking without collapsing separate comments.
export function normalizedSourceKey(record) {
  const url = publicUrl(record.url, record.source);
  if (record.source === 'hn') {
    if (url.pathname !== '/item' || !/^\d+$/.test(url.searchParams.get('id') || '')) throw new Error('Hacker News URL needs an original item ID');
  } else if (record.source === 'github') {
    if (!/^\/[^/]+\/[^/]+\/(?:issues|discussions)\/\d+\/?$/.test(url.pathname)) throw new Error('GitHub URL needs an original issue or discussion ID');
    return `github:${url.pathname.replace(/\/$/, '').toLowerCase()}${/^#(?:issuecomment|discussioncomment)-\d+$/.test(url.hash) ? url.hash : ''}`;
  } else if (record.source === 'reddit') {
    const match = url.pathname.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
    if (!match) throw new Error('Reddit URL needs an original post or comment ID');
    return match[2] ? `reddit:comment:${match[2].toLowerCase()}` : `reddit:post:${match[1].toLowerCase()}`;
  } else if (record.source === 'x') {
    if (!/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/\d+\/?$/.test(url.pathname)) throw new Error('X URL needs an original status ID');
  } else if (record.source === 'stackexchange') {
    const match = url.pathname.match(/^\/questions\/(\d+)(?:\/[^/]+)?\/?$/);
    if (!match) throw new Error('Stack Exchange URL needs an original question ID');
    return `stackexchange:question:${match[1]}${/^#comment\d+_\d+$/.test(url.hash) ? url.hash : ''}`;
  } else if (record.source === 'linkedin') {
    if (!/^\/(?:posts\/[^/]+|feed\/update\/[^/]+)\/?$/.test(url.pathname)) throw new Error('LinkedIn URL must identify a public post');
    const activity = url.pathname.match(/(?:activity-|urn:li:activity:)(\d+)/)?.[1];
    if (activity) return `linkedin:activity:${activity}`;
  }
  return canonicalSourceUrl(record.url);
}

function datasetMetadata(dataset) {
  if (!object(dataset) || typeof dataset.name !== 'string' || !dataset.name.trim() || typeof dataset.license !== 'string' || !dataset.license.trim()) throw new Error('Dataset records need a dataset name, original source URL and license');
  let url; try { url = new URL(dataset.url); } catch { throw new Error('Dataset source URL must be HTTPS'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Dataset source URL must be HTTPS');
}

const communityMetadata = dataset => object(dataset) && (/community.archive/i.test(dataset.name || '') || /(?:community-archive\.org|github\.com\/(?:TheExGenesis|community-archive)\/community-archive)/i.test(dataset.url || ''));
const communityRecord = record => record?.source === 'x' && (record.collection?.provider === 'community-archive' || (Array.isArray(record.collections) ? record.collections : []).some(receipt => receipt?.provider === 'community-archive') || communityMetadata(record.dataset) || (Array.isArray(record.datasets) ? record.datasets : []).some(communityMetadata));

function statusOf(record) {
  const status = String(record.status || 'public').toLowerCase();
  if (isTrue(record.deleted)) return 'deleted';
  if (isTrue(record.removed) || isTrue(record.opted_out) || isTrue(record.optedOut) || PRIVATE_STATUSES.has(status)) return 'removed';
  if (isTrue(record.closed)) return 'closed';
  if (!['public', 'open', 'closed', 'resolved', 'deleted', 'removed', 'active', 'published'].includes(status)) throw new Error(`Unsupported source availability status: ${status}`);
  return ['active', 'published'].includes(status) ? 'public' : status;
}

export function validateNormalizedRecord(record, { now = Date.now() } = {}) {
  if (!object(record) || !HOSTS[record.source]) throw new Error('Expected a normalized record with a supported source');
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_./#-]{0,299}$/.test(record.id)) throw new Error('A stable string source ID is required');
  const prefixes = record.source === 'github' ? ['github:', 'gh:'] : [`${record.source}:`];
  if (!prefixes.some(prefix => record.id.startsWith(prefix))) throw new Error('Source ID prefix does not match its platform');
  if (record.alternateIds !== undefined && (!Array.isArray(record.alternateIds) || record.alternateIds.some(id => typeof id !== 'string' || !prefixes.some(prefix => id.startsWith(prefix)) || !/^[A-Za-z0-9][A-Za-z0-9:_./#-]{0,299}$/.test(id)))) throw new Error('alternateIds must retain valid stable source IDs');
  const sourceKey = normalizedSourceKey(record);
  if (record.alternateUrls !== undefined && (!Array.isArray(record.alternateUrls) || record.alternateUrls.some(url => typeof url !== 'string' || normalizedSourceKey({ ...record, url }) !== sourceKey))) throw new Error('alternateUrls must identify the same original source post');
  if (['hn', 'x'].includes(record.source) && new RegExp(`^${record.source}:\\d+$`).test(record.id) && record.id !== sourceKey) throw new Error('Original source ID and post URL disagree');
  if (record.source === 'reddit' && /^reddit:(?:t[13]_)?[a-z0-9]+$/i.test(record.id) && sourceKey.split(':').at(-1) !== record.id.replace(/^reddit:(?:t[13]_)?/i, '').toLowerCase()) throw new Error('Original Reddit ID and post URL disagree');
  if (record.source === 'stackexchange' && /^stackexchange:\d+$/.test(record.id) && sourceKey.split(':').at(-1) !== record.id.split(':')[1]) throw new Error('Original question ID and post URL disagree');
  if ([record.synthetic, record.is_synthetic, record.dataset?.synthetic].some(isTrue)) throw new Error('Synthetic records cannot be merged as source evidence');
  if (typeof record.date !== 'string' || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > now + 60000) throw new Error('An original, non-future post date is required');
  const status = statusOf(record), redacted = ['deleted', 'removed'].includes(status);
  if (!redacted && (typeof record.text !== 'string' || record.text.trim().length < 20 || typeof record.title !== 'string' || !record.title.trim())) throw new Error('Normalized source title and authored text of at least 20 characters are required');
  if (!redacted && (typeof record.author !== 'string' || !record.author.trim() || /^(?:\[deleted\]|\[removed\]|unknown|anonymous)$/i.test(record.author) || typeof record.authorId !== 'string' || !record.authorId.startsWith(`${record.source}:`) || !record.authorId.slice(record.source.length + 1).trim() || record.authorId.length > 300)) throw new Error('A public author and stable string authorId are required');
  for (const field of ['fetchedAt', 'updatedAt', 'verifiedAt', 'liveVerifiedAt', 'statusCheckedAt']) if (record[field] !== undefined && (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field])))) throw new Error(`${field} must be a date string`);
  for (const field of ['profileUrl', 'threadUrl']) if (record[field]) publicUrl(record[field], record.source, field);
  if (record.dataset !== undefined) datasetMetadata(record.dataset);
  if (record.datasets !== undefined && !Array.isArray(record.datasets)) throw new Error('datasets must be an array of provenance objects');
  for (const dataset of record.datasets || []) datasetMetadata(dataset);
  if (record.origin === 'dataset' && !record.dataset) throw new Error('Dataset records must retain dataset provenance');
  if (record.collection !== undefined && !object(record.collection)) throw new Error('collection must retain a provenance object');
  if (record.collections !== undefined && (!Array.isArray(record.collections) || record.collections.some(value => !object(value)))) throw new Error('collections must be an array of provenance objects');
  if (communityRecord(record)) {
    const dataset = communityMetadata(record.dataset) ? record.dataset : record.datasets?.find(communityMetadata);
    const originalId = `x:${new URL(record.url).pathname.match(/\/status\/(\d+)/)[1]}`;
    if (!dataset || !/^x:\d+$/.test(record.authorId || '') || record.id !== originalId && !(record.alternateIds || []).includes(originalId)) throw new Error('Community Archive records must retain exact string tweet and numeric account IDs');
    if (typeof dataset.exportId !== 'string' || !dataset.exportId || typeof dataset.sourceChecksum !== 'string' || !/^[a-f0-9]{64}$/i.test(dataset.sourceChecksum) || typeof dataset.consentSnapshotAt !== 'string' || !Number.isFinite(Date.parse(dataset.consentSnapshotAt))) throw new Error('Community Archive export ID, checksum and consent snapshot are required');
  }
  return record;
}

function observedAt(record) {
  const fields = [record.liveVerifiedAt, record.verifiedAt, record.statusCheckedAt, record.fetchedAt, record.dataset?.importedAt, record.collection?.collectedAt];
  return Math.max(0, ...fields.map(value => Date.parse(value || '')).filter(Number.isFinite));
}

function cleanRecord(source) {
  const record = structuredClone(source);
  for (const field of DERIVED_RECORD_FIELDS) delete record[field];
  record.request = null; record.problemAnalysis = null; record.signalId = null;
  record.status = statusOf(source);
  if (['deleted', 'removed'].includes(record.status)) {
    // A tombstone keeps the stable reference without retaining withdrawn content.
    const retained = ['id', 'alternateIds', 'source', 'topicId', 'url', 'alternateUrls', 'threadUrl', 'date', 'fetchedAt', 'updatedAt', 'verifiedAt', 'liveVerifiedAt', 'statusCheckedAt', 'status', 'origin', 'recordType', 'authorId', 'dataset', 'datasets', 'collection', 'collections', 'license', 'licenseUrl', 'licenses'];
    const tombstone = Object.fromEntries(retained.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
    return { ...tombstone, title: 'Source unavailable', text: 'This source is unavailable.', author: '', authorId: record.authorId || '', redacted: true, request: null, problemAnalysis: null, signalId: null };
  }
  return record;
}

function mergeRecord(previous, incoming, report) {
  if (previous.source !== incoming.source) throw new Error('One original URL cannot belong to different platforms');
  if (Date.parse(previous.date) !== Date.parse(incoming.date)) throw new Error(`Conflicting original post dates for ${previous.id}`);
  const previousTime = observedAt(previous), incomingTime = observedAt(incoming);
  let preferred = incomingTime >= previousTime ? incoming : previous;
  const oldUnavailable = UNAVAILABLE.has(statusOf(previous)), newUnavailable = UNAVAILABLE.has(statusOf(incoming));
  if (oldUnavailable && (!liveVerified(incoming) || incomingTime < previousTime)) {
    if (!newUnavailable || ['deleted', 'removed'].includes(statusOf(previous))) {
      preferred = previous; report.unavailableKept++;
    }
  } else if (newUnavailable && !(liveVerified(previous) && previousTime > incomingTime)) preferred = incoming;
  const other = preferred === incoming ? previous : incoming;
  const merged = { ...other, ...preferred, id: previous.id, url: previous.url, date: previous.date };
  merged.liveVerified = liveVerified(preferred);
  for (const field of ['deleted', 'removed', 'closed', 'opted_out', 'optedOut', 'redacted']) if (!Object.hasOwn(preferred, field)) delete merged[field];
  merged.alternateIds = unique([...(previous.alternateIds || []), ...(incoming.alternateIds || []), incoming.id]).filter(id => id !== previous.id);
  if (!merged.alternateIds.length) delete merged.alternateIds;
  merged.alternateUrls = unique([...(previous.alternateUrls || []), ...(incoming.alternateUrls || []), incoming.url]).filter(url => url !== previous.url);
  if (!merged.alternateUrls.length) delete merged.alternateUrls;
  merged.collections = unique([...(previous.collections || []), previous.collection, ...(incoming.collections || []), incoming.collection]);
  if (!merged.collections.length) delete merged.collections;
  merged.datasets = unique([...(previous.datasets || []), previous.dataset, ...(incoming.datasets || []), incoming.dataset]);
  if (!merged.datasets.length) delete merged.datasets;
  merged.licenses = unique([...(previous.licenses || []), ...(incoming.licenses || []), previous.license ? { license: previous.license, ...(previous.licenseUrl ? { licenseUrl: previous.licenseUrl } : {}) } : null, incoming.license ? { license: incoming.license, ...(incoming.licenseUrl ? { licenseUrl: incoming.licenseUrl } : {}) } : null]);
  if (!merged.licenses.length) delete merged.licenses;
  if (merged.source === 'x' && !['deleted', 'removed'].includes(statusOf(merged))) {
    const numeric = unique([previous.authorId, incoming.authorId].filter(id => /^x:\d+$/.test(id || '')));
    if (numeric.length > 1) throw new Error(`Conflicting numeric X account IDs for ${previous.id}`);
    if (numeric.length) merged.authorId = numeric[0];
  }
  return merged;
}

function selection(snapshot) {
  const records = snapshot.records.filter(communityRecord);
  const marker = records.length || communityMetadata(snapshot.dataset) || (snapshot.feeds || []).some(feed => feed.adapter === 'community-archive');
  if (!marker) return null;
  const metadata = unique(records.map(record => {
    const dataset = communityMetadata(record.dataset) ? record.dataset : record.datasets?.find(communityMetadata);
    return { exportId: dataset.exportId, checksum: dataset.sourceChecksum, consentSnapshotAt: dataset.consentSnapshotAt };
  }));
  if (metadata.length !== 1) throw new Error('Community Archive selection is empty or mixes exports. A current complete export selection and account eligibility refresh are required.');
  const posts = new Map();
  for (const record of records) {
    const key = normalizedSourceKey(record), hash = digest({ title: record.title, text: record.text, originalHtml: record.originalHtml, author: record.author, authorId: record.authorId, date: Date.parse(record.date), status: statusOf(record), redacted: record.redacted === true });
    if (posts.has(key) && posts.get(key) !== hash) throw new Error('Community Archive selection contains conflicting copies of one post. A complete current export selection is required.');
    posts.set(key, hash);
  }
  return { metadata: metadata[0], records: [...posts].map(([key, hash]) => ({ key, hash })).sort((a, b) => a.key.localeCompare(b.key)) };
}

function addReceipts(snapshots, singular, plural) {
  const receipts = new Map();
  for (const snapshot of snapshots) for (const receipt of [...(snapshot[plural] || []), ...(object(snapshot[singular]) ? [snapshot[singular]] : [])]) {
    if (!object(receipt)) throw new Error(`${plural} must contain provenance objects`);
    const key = receipt.id || receipt.runId || (receipt.startedAt ? `${receipt.startedAt}:${receipt.query || ''}:${receipt.family || ''}` : digest(receipt));
    const prior = receipts.get(key);
    if (!prior) { receipts.set(key, structuredClone(receipt)); continue; }
    const time = value => Date.parse(value.completedAt || value.finishedAt || value.updatedAt || value.startedAt || '') || 0;
    const recent = time(receipt) >= time(prior) ? receipt : prior;
    const earlier = recent === receipt ? prior : receipt;
    const combined = { ...earlier, ...recent };
    for (const field of ['attempts', 'errors']) if (Array.isArray(prior[field]) || Array.isArray(receipt[field])) combined[field] = unique([...(prior[field] || []), ...(receipt[field] || [])]);
    receipts.set(key, combined);
  }
  return [...receipts.values()];
}

function expansionFeeds(runs) {
  return runs.flatMap(run => (Array.isArray(run.health) ? run.health : []).filter(health => object(health) && typeof health.provider === 'string').map(health => {
    const knownStatuses = ['ok', 'complete', 'success', 'error', 'unavailable', 'rate-limited', 'blocked'];
    const status = health.status === 'backoff' || health.status === 'rate_limited' ? 'rate-limited' : knownStatuses.includes(health.status) ? health.status : 'error';
    const retryText = String(health.error || '').match(/\bretry after (\d{4}-\d\d-\d\dT[\d:.]+Z)/i)?.[1];
    const retryAt = health.retryAt ?? (retryText && Number.isFinite(Date.parse(retryText)) ? retryText : null);
    return {
      ...health,
      source: health.provider,
      status,
      ...(status !== health.status ? { collectionStatus: health.status } : {}),
      count: health.count ?? health.rawCount ?? 0,
      fetchedAt: run.completedAt || run.startedAt || health.fetchedAt || null,
      ...(run.id ? { runId: run.id } : {}),
      ...(retryAt ? { retryAt } : {}),
    };
  }));
}

function validateSnapshot(snapshot, label, now, rejected) {
  if (!object(snapshot) || !Array.isArray(snapshot.records)) throw new Error(`${label} must be a normalized JSON object with a records array`);
  for (const field of ['feeds', 'expansions', 'collections', 'mergeReceipts']) if (snapshot[field] !== undefined && !Array.isArray(snapshot[field])) throw new Error(`${label}.${field} must be an array`);
  const records = snapshot.records.filter((record, index) => {
    try { validateNormalizedRecord(record, { now }); return true; }
    catch (error) {
      const message = `${label}.records[${index}] (${record?.id || 'unknown'}): ${error.message}`;
      if (communityRecord(record) || record?.source === 'x' && communityMetadata(snapshot.dataset)) throw new Error(message);
      rejected.push({ input: label, row: index, id: record?.id ?? null, url: record?.url ?? null, error: error.message });
      return false;
    }
  });
  return { ...snapshot, records };
}

/** Merge only normalized public-source snapshots. No I/O, models or source access. */
export function mergeNormalizedSnapshots(base, inputs = [], options = {}) {
  const now = options.now ?? Date.now(), labels = [options.baseLabel || 'base', ...inputs.map((_, index) => options.inputLabels?.[index] || `input[${index}]`)];
  const originals = [base, ...inputs], rejected = [];
  const snapshots = originals.map((snapshot, index) => validateSnapshot(snapshot, labels[index], now, rejected));
  let archiveSelection = selection(snapshots[0]);
  for (const snapshot of snapshots.slice(1)) {
    const incomingSelection = selection(snapshot);
    if (!incomingSelection) continue;
    if (archiveSelection && stable(archiveSelection) !== stable(incomingSelection)) throw new Error('Community Archive refresh rejected: the export, consent snapshot or complete selected post set changed. A new current account eligibility refresh and complete export selection are required before replacing prior archive records. Partial selections cannot prove withdrawal, so no output was written.');
    archiveSelection = incomingSelection;
  }
  const records = new Map(), identities = new Map();
  const report = { status: 'pending-reanalysis', inputRecords: originals.reduce((sum, snapshot) => sum + snapshot.records.length, 0), baseRecords: base.records.length, added: 0, duplicates: 0, unavailableKept: 0, rejectedRows: rejected.length, rejectedSources: new Set(rejected.map(row => row.id || row.url || `${row.input}:${row.row}`)).size, rejected, records: 0 };
  snapshots.forEach(snapshot => snapshot.records.forEach(source => {
    const key = normalizedSourceKey(source);
    for (const id of [source.id, ...(source.alternateIds || [])]) {
      const priorKey = identities.get(id);
      if (priorKey && priorKey !== key) throw new Error(`Source ID ${id} points to multiple original posts`);
      identities.set(id, key);
    }
    const incoming = structuredClone(source), previous = records.get(key);
    if (previous) { records.set(key, mergeRecord(previous, incoming, report)); report.duplicates++; }
    else records.set(key, incoming);
  }));
  const output = structuredClone(base);
  for (const field of DERIVED_CORPUS_FIELDS) delete output[field];
  output.version = Math.max(4, ...snapshots.map(snapshot => Number(snapshot.version) || 0));
  output.fetchedAt = new Date(now).toISOString();
  output.records = [...records.values()].map(cleanRecord);
  output.expansions = addReceipts(snapshots, 'expansion', 'expansions');
  // Source health and the UI consume feeds. Keep raw runs as well as this bridge.
  output.feeds = unique([...snapshots.flatMap(snapshot => snapshot.feeds || []), ...expansionFeeds(output.expansions)]);
  output.collections = addReceipts(snapshots, 'collection', 'collections');
  if (output.expansions.length) output.expansion = output.expansions.at(-1); else delete output.expansion;
  if (output.collections.length) output.collection = output.collections.at(-1); else delete output.collection;
  output.coverage = Object.assign({}, ...snapshots.map(snapshot => snapshot.coverage || {}));
  output.mergeReceipts = unique([...snapshots.flatMap(snapshot => snapshot.mergeReceipts || []), ...originals.map((snapshot, index) => ({ input: labels[index], sha256: options.inputHashes?.[index] || digest(snapshot), recordCount: snapshot.records.length, ...(snapshot.fetchedAt ? { fetchedAt: snapshot.fetchedAt } : {}), ...(snapshot.dataset ? { dataset: snapshot.dataset } : {}), ...(snapshot.report ? { report: snapshot.report } : {}) }))]);
  output.signals = []; output.membershipAudits = [];
  output.analysis = { status: 'pending', method: 'pending-reanalysis' };
  const baseKeys = new Set(snapshots[0].records.map(normalizedSourceKey));
  report.added = [...records.keys()].filter(key => !baseKeys.has(key)).length;
  report.records = output.records.length;
  output.merge = report;
  return output;
}
