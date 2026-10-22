import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { plainText } from './data.mjs';
import { topicFor } from './sources.mjs';
import { detectRequest, SOFTWARE } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';
import { normalizeImportedRow } from './imports.mjs';

export const REDDIT_ARCHIVE = {
  name: 'Project Arctic Shift public Reddit archive',
  url: 'https://github.com/ArthurHeitmann/arctic_shift',
  api: 'https://arctic-shift.photon-reddit.com',
  documentation: 'https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md',
  collectionNotes: 'https://github.com/ArthurHeitmann/arctic_shift/blob/master/file_content_explanations.md',
  removal: 'https://github.com/ArthurHeitmann/arctic_shift#contact--removal-requests',
  license: 'No archive content license specified. Original authors retain rights. Public research cache; redistribution rights are not asserted.',
};
export const COMMUNITY_ARCHIVE = {
  name: 'Community Archive consent-managed public X export',
  url: 'https://github.com/TheExGenesis/community-archive/releases/latest',
  documentation: 'https://www.community-archive.org/docs',
  policy: 'https://www.community-archive.org/data-policy',
  latest: 'https://fabxmporizzqflnftavs.supabase.co/storage/v1/object/public/community-archive-public-export/latest.json',
  license: 'Public consent-managed export. No explicit content license in manifest; original author rights apply. Archive privacy policy permits public access and analysis.',
};
const AGENT = 'InternetAtlas/0.3 public research; local single-user prototype';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const REQUEST_INTENT = /\b(?:looking for|in search of|i (?:need|want|wish)|we (?:need|want)|is there|are there|any (?:good|decent|free|open source)|recommend|alternative|suggestions|feature request|please add|would (?:love|like|be great|be nice)|how (?:can|do) i|help (?:me )?(?:find|with))\b/i;
const PROMOTION = /\b(?:i (?:built|created|launched)|we (?:built|created|launched)|my new (?:app|tool)|our (?:product|platform)|looking for (?:testers|beta users|customers))\b/i;

export function redditDatasetRecord(row, metadata, options = {}) {
  const now = options.now ?? Date.now(), minimumDate = options.minimumDate ?? now - 365 * 86400000;
  const text = plainText(row.body ?? row.selftext ?? ''), isComment = row.record_type === 'comment';
  const title = plainText(row.title || text.slice(0, 110));
  const date = Number(row.created_utc) * 1000;
  if (row.synthetic || row.is_synthetic || row.is_nsfw || row.over_18 || row.deleted || row.removed || !Number.isFinite(date) || date < minimumDate || date > now + 60000) return null;
  if (/^(?:\[deleted\]|\[removed\])$/i.test(text) || /automoderator|\[bot\]/i.test(row.author || '')) return null;
  if (!SOFTWARE.test(isComment ? text : `${title}\n${text}`) || !REQUEST_INTENT.test(isComment ? text : `${title}\n${text}`) || PROMOTION.test(isComment ? text : `${title}\n${text}`)) return null;
  try {
    const record = normalizeImportedRow({ ...row, title, text, date: new Date(date).toISOString(), profile_url: `https://www.reddit.com/user/${encodeURIComponent(row.author)}/` }, { ...metadata, source: 'reddit' });
    record.community = String(row.subreddit || '');
    if (isComment && row.link_id && /^[a-z0-9]+$/i.test(String(row.link_id))) record.threadUrl = `https://www.reddit.com/r/${encodeURIComponent(record.community)}/comments/${row.link_id}/`;
    record.dataset = { ...record.dataset, revision: metadata.revision, licenseUrl: metadata.licenseUrl, liveVerified: false };
    record.collection = { provider: 'public-dataset', query: metadata.query || 'Authored software asks', endpoint: metadata.url };
    return record;
  } catch { return null; }
}

export function communityArchiveRecord(row, manifest, options = {}) {
  const now = options.now ?? Date.now(), minimumDate = options.minimumDate ?? now - 365 * 86400000;
  const tweetId = row.tweet_id, accountId = row.account_id, username = String(row.username || '').replace(/^@/, '');
  // Numeric IDs are rejected because JS may already have lost their precision.
  if (typeof tweetId !== 'string' || !/^\d{10,25}$/.test(tweetId) || typeof accountId !== 'string' || !/^\d+$/.test(accountId) || !/^[A-Za-z0-9_]{1,15}$/.test(username)) return null;
  const dateValue = String(row.created_at || '').replace(' ', 'T');
  const date = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(dateValue) ? dateValue : `${dateValue}Z`);
  const text = plainText(row.full_text || '');
  if (!Number.isFinite(date) || date < minimumDate || date > now + 60000 || text.length < 30) return null;
  if (row.synthetic || row.is_synthetic || row.retweeted_tweet_id || /^RT\s+@/i.test(text) || row.deleted || row.opted_out || !SOFTWARE.test(text) || !REQUEST_INTENT.test(text) || PROMOTION.test(text)) return null;
  if (manifest?.publication?.status !== 'published' || !manifest.export_id || !manifest.consent?.snapshot_at) return null;
  if (options.eligibleAccountIds && !options.eligibleAccountIds.has(accountId)) return null;
  const url = `https://x.com/${username}/status/${tweetId}`;
  const record = {
    id: `x:${tweetId}`, source: 'x', topicId: topicFor(text), title: text.slice(0, 110), text,
    author: username, authorId: `x:${accountId}`, profileUrl: `https://x.com/${username}`,
    url, threadUrl: row.conversation_id && /^\d+$/.test(String(row.conversation_id)) ? `https://x.com/i/status/${row.conversation_id}` : url,
    date: new Date(date).toISOString(), fetchedAt: new Date(now).toISOString(), status: 'public', replies: 0,
    recordType: row.reply_to_tweet_id ? 'comment' : 'post', origin: 'dataset',
    dataset: { ...COMMUNITY_ARCHIVE, exportId: manifest.export_id, consentSnapshotAt: manifest.consent.snapshot_at, sourceChecksum: manifest.files?.tweets?.sha256 || null, importedAt: new Date(now).toISOString(), liveVerified: false },
    collection: { provider: 'community-archive', query: 'Recent original software asks', endpoint: COMMUNITY_ARCHIVE.latest },
  };
  return { ...record, request: detectRequest(record) };
}

// Retrieval lanes are provenance only. They never assign problem membership.
export const ARCHIVE_LANES = [
  { subreddit: 'software', pages: 30 },
  { subreddit: 'selfhosted', query: 'pdf', pages: 8 },
  { subreddit: 'selfhosted', query: 'calendar', pages: 8 },
  { subreddit: 'selfhosted', query: 'bookmark', pages: 8 },
  { subreddit: 'selfhosted', query: 'budget', pages: 8 },
  { subreddit: 'selfhosted', query: 'document', pages: 8 },
  { subreddit: 'selfhosted', query: 'photo', pages: 8 },
  { subreddit: 'selfhosted', query: 'notes', pages: 8 },
  { subreddit: 'selfhosted', query: 'invoice', pages: 8 },
  { subreddit: 'selfhosted', pages: 20 },
  { subreddit: 'ObsidianMD', query: 'sync', pages: 10 },
  { subreddit: 'ObsidianMD', query: 'search', pages: 8 },
  { subreddit: 'ChatGPT', query: 'export', pages: 8 },
  { subreddit: 'ChatGPT', query: 'search', pages: 8 },
  { subreddit: 'LocalLLaMA', query: 'memory', pages: 8 },
  { subreddit: 'AI_Agents', query: 'memory', pages: 8 },
  { subreddit: 'macapps', pages: 20 },
  { subreddit: 'SomebodyMakeThis', pages: 12 },
  { subreddit: 'AppIdeas', pages: 10 },
  { subreddit: 'n8n', query: 'webhook', pages: 8 },
  { subreddit: 'smallbusiness', query: 'software', pages: 10 },
  { subreddit: 'SaaS', query: 'looking for', pages: 8 },
];

export function archiveRecord(row, options = {}) {
  const now = options.now ?? Date.now(), minimumDate = options.minimumDate ?? 0;
  const author = String(row.author || '').trim(), id = String(row.id || '').replace(/^t3_/, '');
  const title = plainText(row._meta?.edited_title || row.title || ''), body = plainText(row.selftext || '');
  const seconds = Number(row.created_utc), date = seconds * 1000;
  if (row.synthetic || row.is_synthetic || !/^[a-z0-9]+$/i.test(id) || !author || /^(?:\[deleted\]|\[removed\]|automoderator|unknown|anonymous)$/i.test(author) || /bot$/i.test(author)) return null;
  if (!Number.isFinite(date) || date < minimumDate || date > now + 60000) return null;
  // Arctic Shift retains initial moderation flags after an approved post is restored.
  // Its documented second retrieval explicitly marks restoration and later deletion.
  const restored = row._meta?.was_initially_deleted === true && row._meta?.was_deleted_later !== true;
  if (row._meta?.was_deleted_later || row.over_18 || row.quarantine || row.subreddit_type === 'private' || (!restored && (row.removed_by_category || row.removal_reason || row.banned_by || row.is_robot_indexable === false))) return null;
  if (/^\s*\[(?:deleted|removed)\]\s*$/i.test(body) || body.length < 20) return null;
  if (!SOFTWARE.test(`${title}\n${body}`)) return null;
  if (options.requestsOnly !== false && (!REQUEST_INTENT.test(`${title}\n${body}`) || PROMOTION.test(`${title}\n${body}`))) return null;
  const subreddit = String(row.subreddit || '').replace(/^r\//, '');
  if (!/^[a-z0-9_]+$/i.test(subreddit)) return null;
  const permalink = String(row.permalink || `/r/${subreddit}/comments/${id}/`);
  let url;
  try {
    const parsed = new URL(permalink, 'https://www.reddit.com');
    if (parsed.protocol !== 'https:' || !['www.reddit.com', 'reddit.com'].includes(parsed.hostname) || !new RegExp(`/comments/${id}(?:/|$)`).test(parsed.pathname)) return null;
    url = parsed.toString();
  } catch { return null; }
  const fetchedAt = new Date(now).toISOString();
  const record = {
    id: `reddit:${id}`, source: 'reddit', topicId: topicFor(`${title} ${body}`),
    title, text: body.slice(0, 6000), author, authorId: `reddit:${author.toLowerCase()}`,
    profileUrl: `https://www.reddit.com/user/${encodeURIComponent(author)}/`,
    url, threadUrl: url, date: new Date(date).toISOString(), fetchedAt,
    status: 'public', replies: Number(row.num_comments) || 0, community: subreddit,
    recordType: 'post', origin: 'dataset',
    dataset: { ...REDDIT_ARCHIVE, importedAt: fetchedAt, archivedAt: Number(row._meta?.retrieved_2nd_on || row.retrieved_on) ? new Date(Number(row._meta?.retrieved_2nd_on || row.retrieved_on) * 1000).toISOString() : null, restoredAfterModeration: restored, liveVerified: false },
    collection: { provider: 'arctic-shift', lane: options.lane || subreddit, query: options.query || '', endpoint: options.endpoint || null },
  };
  return { ...record, request: detectRequest(record) };
}

function retryAt(response, now) {
  const seconds = Number(response.headers.get('retry-after'));
  if (seconds > 0) return now + seconds * 1000;
  const value = Date.parse(response.headers.get('retry-after') || '');
  return Number.isFinite(value) ? value : now + 60000;
}

// Bounded serial collection. Access denial and throttling stop the entire run.
export async function collectArchiveRequests(directory, progress = () => {}, options = {}) {
  const fetcher = options.fetch || fetch, sleep = options.sleep || pause, now = options.now || Date.now;
  const lanes = options.lanes || ARCHIVE_LANES, sinceDays = options.sinceDays || 365;
  const maxRecords = options.maxRecords || 12000, maxRequests = options.maxRequests || 250;
  const cacheDirectory = join(directory, 'raw'); await mkdir(cacheDirectory, { recursive: true });
  const records = new Map(), reports = [], errors = [];
  const minimumDate = (Math.floor(now() / 86400000) - sinceDays) * 86400000;
  let requests = 0, scanned = 0, cacheHits = 0, stopped = false;
  const persist = async () => {
    const fetchedAt = new Date(now()).toISOString();
    const lastError = errors.at(-1);
    const data = { fetchedAt, dataset: REDDIT_ARCHIVE, records: [...records.values()], feeds: [{ source: 'reddit', adapter: 'arctic-shift', status: records.size ? 'ok' : 'error', count: records.size, fetchedAt, error: lastError?.message || null, query: 'Public software request archive', retryAt: lastError?.retryAt || null }], report: { requests, scanned, cacheHits, accepted: records.size, sinceDays, errors: [...errors], lanes: [...reports], stopped } };
    const temporary = join(directory, `reddit-archive.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(data, null, 2)); await rename(temporary, join(directory, 'reddit-archive.json'));
    return data;
  };
  let lastSnapshot = 0;
  for (const lane of lanes) {
    if (stopped || records.size >= maxRecords || requests >= maxRequests) break;
    let before = Math.floor(now() / 86400000) * 86400, fetched = 0, accepted = 0, pages = 0;
    let windowStart = lane.query ? Math.max(minimumDate / 1000, before - 30 * 86400) : minimumDate / 1000;
    for (let page = 0; page < lane.pages; page++) {
      if (records.size >= maxRecords || requests >= maxRequests || before * 1000 <= minimumDate) break;
      if (options.signal?.aborted) throw options.signal.reason || new Error('Dataset collection cancelled');
      const endpoint = new URL('/api/posts/search', REDDIT_ARCHIVE.api);
      for (const [key, value] of Object.entries({ subreddit: lane.subreddit, query: lane.query, limit: 100, sort: 'desc', after: Math.floor(windowStart), before: Math.ceil(before) })) if (value !== undefined) endpoint.searchParams.set(key, String(value));
      const cacheKey = digest(endpoint.toString());
      const cachePath = join(cacheDirectory, `${cacheKey}.json`);
      let data;
      try { const cached = JSON.parse(await readFile(cachePath, 'utf8')); if (now() - cached.cachedAt < 86400000) { data = cached.data; cacheHits++; } } catch { /* No valid public cache. */ }
      if (!data) {
        try {
          if (requests) await sleep(options.delayMs ?? 2500);
          const response = await fetcher(endpoint, { headers: { 'User-Agent': AGENT, Accept: 'application/json' }, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
          requests++;
          if ([401, 403, 429].includes(response.status)) {
            stopped = true;
            errors.push({ provider: 'arctic-shift', status: response.status, retryAt: response.status === 429 ? new Date(retryAt(response, now())).toISOString() : null, message: 'Access or rate limit stopped collection. No alternate endpoint was attempted.' });
            break;
          }
          if (!response.ok) {
            const message = (await response.text()).slice(0, 300);
            if (response.status === 422 && /timeout|slow down/i.test(message)) await sleep(options.slowDelayMs ?? 8000);
            throw new Error(`HTTP ${response.status}: ${message}`);
          }
          const result = await response.json();
          if (!Array.isArray(result.data)) throw new Error('Archive response has no data array');
          data = result.data;
          await writeFile(cachePath, JSON.stringify({ cachedAt: now(), endpoint: endpoint.toString(), data }));
        } catch (error) { errors.push({ provider: 'arctic-shift', subreddit: lane.subreddit, query: lane.query || '', message: error.message }); break; }
      }
      pages++; fetched += data.length; scanned += data.length;
      if (!data.length) {
        if (lane.query && windowStart * 1000 > minimumDate) { before = windowStart; windowStart = Math.max(minimumDate / 1000, before - 30 * 86400); continue; }
        break;
      }
      for (const row of data) {
        const record = archiveRecord(row, { now: now(), minimumDate, lane: lane.subreddit, query: lane.query, endpoint: endpoint.toString(), requestsOnly: options.requestsOnly });
        if (!record || records.size >= maxRecords) continue;
        const key = canonicalSourceUrl(record.url);
        if (!records.has(key)) { records.set(key, record); accepted++; }
      }
      progress({ phase: 'dataset', provider: 'arctic-shift', subreddit: lane.subreddit, query: lane.query || '', page: page + 1, fetched: data.length, accepted: records.size, scanned, requests, cacheHits });
      if (records.size - lastSnapshot >= 250) { await persist(); lastSnapshot = records.size; }
      const oldest = Math.min(...data.map(row => Number(row.created_utc)).filter(Number.isFinite));
      if (!Number.isFinite(oldest) || oldest >= before) break;
      before = oldest;
      if (data.length < 100) {
        if (lane.query && windowStart * 1000 > minimumDate) { before = windowStart; windowStart = Math.max(minimumDate / 1000, before - 30 * 86400); continue; }
        break;
      }
    }
    reports.push({ subreddit: lane.subreddit, query: lane.query || '', pages, fetched, accepted });
    await persist();
  }
  return persist();
}
