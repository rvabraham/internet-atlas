import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parse } from 'csv-parse';
import { createHash } from 'node:crypto';
import { plainText } from './data.mjs';
import { topicFor } from './sources.mjs';
import { detectRequest } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

const HOSTS = { reddit: ['reddit.com', 'www.reddit.com', 'old.reddit.com'], x: ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'], linkedin: ['linkedin.com', 'www.linkedin.com'], hn: ['news.ycombinator.com'], github: ['github.com'], stackexchange: ['softwarerecs.stackexchange.com'] };
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const pick = (row, field, aliases) => row[field] ?? aliases.map(alias => row[alias]).find(value => value !== undefined && value !== null);
export function normalizeImportedRow(row, metadata, columns = {}) {
  const source = String(metadata.source || row.source || '').toLowerCase().replace('twitter', 'x');
  if (!HOSTS[source]) throw new Error('Unsupported platform');
  if ([row.synthetic, row.is_synthetic, metadata.synthetic].some(value => value === true || /^(?:true|1|yes)$/i.test(String(value)))) throw new Error('Synthetic records do not count as user requests');
  let url = pick(row, columns.url, ['url', 'permalink', 'post_url', 'original_url']);
  if (source === 'reddit' && String(url).startsWith('/r/')) url = `https://www.reddit.com${url}`;
  let parsed; try { parsed = new URL(url); } catch { throw new Error('Original public post URL is missing'); }
  if (parsed.protocol !== 'https:' || !HOSTS[source].includes(parsed.hostname)) throw new Error('Original URL does not match its platform');
  if (source === 'linkedin' && !/^\/(?:posts\/|feed\/update\/)/.test(parsed.pathname)) throw new Error('LinkedIn profile rows are not request posts');
  if (source === 'x' && !/\/status\/\d+/.test(parsed.pathname)) throw new Error('X post URL is missing a status ID');
  if (source === 'reddit' && !/\/comments\//.test(parsed.pathname)) throw new Error('Reddit post URL is required');
  if (source === 'github' && !/^\/[^/]+\/[^/]+\/(?:issues|discussions)\/\d+\/?$/.test(parsed.pathname)) throw new Error('GitHub issue or discussion URL is required');
  if (source === 'hn' && (parsed.pathname !== '/item' || !/^\d+$/.test(parsed.searchParams.get('id') || ''))) throw new Error('Hacker News item URL is required');
  if (source === 'stackexchange' && !/^\/questions\/\d+(?:\/|$)/.test(parsed.pathname)) throw new Error('Stack Exchange question URL is required');
  const text = plainText(pick(row, columns.text, ['text', 'body', 'selftext', 'post_text', 'content']) || '');
  const author = plainText(pick(row, columns.author, ['author', 'username', 'user', 'author_name']) || '').replace(/^\/u\//, '').replace(/^@/, '');
  if (text.length < 20 || !author || ['[deleted]', '[removed]', 'unknown', 'anonymous'].includes(author.toLowerCase())) throw new Error('Request text and a public author are required');
  const rawDate = pick(row, columns.date, ['date', 'created_at', 'created_utc', 'timestamp', 'datetime', 'published_at']);
  const numeric = typeof rawDate === 'number' || /^\d{9,13}$/.test(String(rawDate));
  const date = numeric ? new Date(Number(rawDate) * (Number(rawDate) < 1e12 ? 1000 : 1)) : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) throw new Error('Original post date is missing');
  const profile = pick(row, columns.profile, ['profileUrl', 'profile_url', 'author_url']);
  let profileUrl = url;
  try { const candidate = new URL(profile); if (candidate.protocol === 'https:' && HOSTS[source].includes(candidate.hostname)) profileUrl = candidate.toString(); } catch { /* The original post remains a public reply path. */ }
  const identity = ['reddit', 'x', 'github'].includes(source) ? author.toLowerCase() : row.author_id || row.user_id || (profileUrl !== url ? canonicalSourceUrl(profileUrl) : author);
  const id = `${source}:import:${hash(canonicalSourceUrl(url))}`;
  const title = plainText(pick(row, columns.title, ['title', 'subject']) || text.slice(0, 110));
  let threadUrl = parsed.toString();
  try { const candidate = new URL(row.thread_url); if (candidate.protocol === 'https:' && HOSTS[source].includes(candidate.hostname)) threadUrl = candidate.toString(); } catch { /* Use original post. */ }
  const record = { id, source, topicId: topicFor(`${title} ${text}`), title, text: text.slice(0, 6000), author, authorId: `${source}:${identity}`, profileUrl, url: parsed.toString(), threadUrl, date: date.toISOString(), fetchedAt: new Date().toISOString(), status: row.status || 'public', replies: 0, origin: 'dataset', recordType: row.record_type || 'post', dataset: { name: metadata.name, url: metadata.url, license: metadata.license, importedAt: new Date().toISOString() } };
  return { ...record, request: detectRequest(record) };
}

export async function importDataset(path, metadata, columns = {}, maxRows = 50000) {
  if (!metadata.name || !metadata.url || !metadata.license) throw new Error('Dataset name, source page and license are required for provenance');
  try { const source = new URL(metadata.url); if (source.protocol !== 'https:') throw new Error(); } catch { throw new Error('Dataset source page must be HTTPS'); }
  const records = [], rejected = {}, urls = new Set(); let read = 0, duplicates = 0;
  const accept = row => {
    read++; if (read > maxRows) throw new Error(`Import is limited to ${maxRows} rows per run`);
    try { const record = normalizeImportedRow(row, metadata, columns); const key = canonicalSourceUrl(record.url); if (urls.has(key)) { duplicates++; return; } urls.add(key); records.push(record); }
    catch (error) { rejected[error.message] = (rejected[error.message] || 0) + 1; }
  };
  if (/\.csv$/i.test(path)) {
    for await (const row of createReadStream(path).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, max_record_size: 100000 }))) accept(row);
  } else if (/\.jsonl$|\.ndjson$/i.test(path)) {
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) accept(JSON.parse(line));
  } else if (/\.json$/i.test(path)) {
    const data = JSON.parse(await readFile(path, 'utf8')); const rows = Array.isArray(data) ? data : data.records || data.data;
    if (!Array.isArray(rows)) throw new Error('JSON must contain an array of records'); for (const row of rows) accept(row);
  } else throw new Error('Use CSV, JSON or JSONL');
  return { records, report: { read, accepted: records.length, duplicates, rejected } };
}
