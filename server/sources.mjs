import { XMLParser } from 'fast-xml-parser';
import { TOPICS, plainText, tokens, publicFetch, dedupe } from './data.mjs';
import { detectRequest, SOFTWARE } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

const AGENT = 'InternetAtlas/0.2 public research; local single-user prototype';
const SUBREDDITS = ['selfhosted', 'software', 'SomebodyMakeThis', 'smallbusiness', 'SaaS', 'n8n', 'ObsidianMD', 'Notion', 'webdev', 'AI_Agents', 'LocalLLaMA', 'Automate'];
const INTENTS = ['"I wish"', '"looking for a tool"', '"is there a tool"', '"I would pay"', '"I need" software', '"feature request"', '"wish there was"', '"any recommendations" software', '"looking for" automation', '"would love" software', '"please add"', '"need a tool"'];
const EXTRA_REPOS = { agents: ['langchain-ai/langchain', 'mem0ai/mem0'], retrieval: ['Mintplex-Labs/anything-llm', 'open-webui/open-webui'], data: ['pocketbase/pocketbase'], testing: ['vitest-dev/vitest'], observability: ['langfuse/langfuse', 'SigNoz/signoz'], integrations: ['triggerdotdev/trigger.dev'], auth: ['better-auth/better-auth'], billing: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function topicFor(text) {
  const words = new Set(tokens(text));
  const ranked = TOPICS.filter(t => t.id !== 'software').map(t => ({ id: t.id, score: t.terms.reduce((sum, term) => sum + (words.has(term) || words.has(term + 's') ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].id : 'software';
}
export function hnRecord(hit) {
  const text = plainText(hit.comment_text || hit.story_text || ''), title = plainText(hit.story_title || hit.title || 'Hacker News');
  if (!hit.author || hit.author === '[deleted]' || text.length < 50 || !SOFTWARE.test(`${title} ${text}`)) return null;
  return { id: `hn:${hit.objectID}`, source: 'hn', topicId: topicFor(`${title} ${text}`), title, text: text.slice(0, 6000), author: hit.author, authorId: `hn:${hit.author}`, profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}`, url: `https://news.ycombinator.com/item?id=${hit.objectID}`, threadUrl: `https://news.ycombinator.com/item?id=${hit.story_id || hit.objectID}`, date: hit.created_at, fetchedAt: new Date().toISOString(), status: 'public', replies: hit.num_comments || 0, recordType: hit.comment_text ? 'comment' : 'post', origin: 'live-api' };
}
export function githubRecord(hit, topicId) {
  const text = plainText(hit.body || hit.title);
  if (!hit.user || hit.user.type === 'Bot' || text.length < 30) return null;
  return { id: `gh:${hit.id}`, source: 'github', topicId, title: hit.title, text: text.slice(0, 6000), author: hit.user.login, authorId: `github:${hit.user.login}`, profileUrl: hit.user.html_url, url: hit.html_url, threadUrl: hit.html_url, apiUrl: hit.url, date: hit.created_at, updatedAt: hit.updated_at, fetchedAt: new Date().toISOString(), status: hit.state, replies: hit.comments, repository: hit.repository_url?.split('/').slice(-2).join('/'), labels: (hit.labels || []).map(l => l.name), recordType: 'post', origin: 'live-api' };
}
export function parseRedditFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported feed declarations');
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml);
  const entries = parsed.feed?.entry;
  if (!entries) return [];
  return (Array.isArray(entries) ? entries : [entries]).flatMap(entry => {
    const author = String(entry.author?.name || '').replace(/^\/u\//, '');
    const link = (Array.isArray(entry.link) ? entry.link.find(l => l['@_rel'] !== 'self') : entry.link)?.['@_href'];
    if (!author || !link || ['[deleted]', 'AutoModerator'].includes(author)) return [];
    const url = new URL(link);
    if (!['www.reddit.com', 'reddit.com'].includes(url.hostname)) return [];
    const title = plainText(entry.title), raw = typeof entry.content === 'string' ? entry.content : entry.content?.['#text'] || '';
    const text = plainText(plainText(raw).replace(/\s+submitted by\s+[\s\S]*$/i, ''));
    const date = String(entry.published || entry.updated || '');
    if (!text || !Number.isFinite(Date.parse(date)) || !SOFTWARE.test(`${title} ${text}`)) return [];
    return [{ id: `reddit:${entry.id}`, source: 'reddit', topicId: topicFor(`${title} ${text}`), title, text: text.slice(0, 6000), author, authorId: `reddit:${author.toLowerCase()}`, profileUrl: `https://www.reddit.com/user/${encodeURIComponent(author)}/`, url: link, threadUrl: link, date, fetchedAt: new Date().toISOString(), status: 'public', replies: 0, community: String(entry.category?.['@_term'] || parsed.feed.category?.['@_term'] || ''), recordType: 'post', origin: 'public-feed' }];
  });
}
export async function redditFeed(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.reddit.com', 'reddit.com'].includes(parsed.hostname) || !parsed.pathname.endsWith('.rss')) throw new Error('Unsupported public feed');
  const response = await fetch(url, { headers: { 'User-Agent': AGENT, Accept: 'application/atom+xml' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Reddit feed: HTTP ${response.status}`);
  const xml = await response.text(); if (!xml.trim()) throw new Error('Reddit returned an empty feed');
  return parseRedditFeed(xml);
}
export function stackRecord(hit) {
  if (!hit.owner?.user_id || !hit.body || !hit.link) return null;
  const title = plainText(hit.title), text = plainText(hit.body);
  return { id: `stackexchange:${hit.question_id}`, source: 'stackexchange', topicId: topicFor(`${title} ${text} ${(hit.tags || []).join(' ')}`), title, text: text.slice(0, 6000), author: plainText(hit.owner.display_name), authorId: `stackexchange:${hit.owner.user_id}`, profileUrl: hit.owner.link || hit.link, url: hit.link, threadUrl: hit.link, apiUrl: `https://api.stackexchange.com/2.3/questions/${hit.question_id}?site=softwarerecs&filter=withbody`, date: new Date(hit.creation_date * 1000).toISOString(), fetchedAt: new Date().toISOString(), status: hit.closed_date ? 'closed' : 'public', replies: hit.answer_count || 0, labels: hit.tags || [], recordType: 'post', origin: 'live-api', license: hit.content_license || 'CC BY-SA', licenseUrl: 'https://stackoverflow.com/help/licensing' };
}

export async function collectRequests(query, previous, onProgress = () => {}) {
  query = String(query || '').trim().slice(0, 160);
  if (query.length < 3) throw new Error('Use a specific problem to collect requests.');
  const records = [...previous.records], feeds = [...(previous.feeds || [])];
  const cutoff = Math.floor(Date.now() / 1000) - 365 * 86400;
  let added = 0;
  for (let page = 0; page < 2; page++) {
    try {
      const data = await publicFetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&hitsPerPage=100&page=${page}&numericFilters=created_at_i%3E${cutoff}`);
      const found = (data.hits || []).map(hnRecord).filter(Boolean); records.push(...found); added += found.length;
      feeds.push({ source: 'hn', query, status: 'ok', count: found.length, fetchedAt: new Date().toISOString() });
      onProgress({ phase: 'collecting', source: 'hn', count: found.length });
      if ((data.hits || []).length < 100) break;
    } catch (error) { feeds.push({ source: 'hn', query, status: 'error', error: error.message }); break; }
  }
  try {
    const found = await redditFeed(`https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=year&limit=100`);
    records.push(...found); added += found.length;
    feeds.push({ source: 'reddit', query, status: 'ok', count: found.length, fetchedAt: new Date().toISOString() });
    onProgress({ phase: 'collecting', source: 'reddit', count: found.length });
  } catch (error) { feeds.push({ source: 'reddit', query, status: 'error', error: error.message }); }
  if (!added) throw new Error('No live records returned. Existing atlas was kept.');
  const unique = new Map(records.map(record => [canonicalSourceUrl(record.url), record]));
  return { ...previous, records: [...unique.values()], feeds: feeds.slice(-200), fetchedAt: new Date().toISOString() };
}

export async function ingestPublic(onProgress = () => {}, previous = { records: [] }) {
  const records = [...previous.records], feeds = [], githubHits = [], cutoff = Math.floor(Date.now() / 1000) - 365 * 86400;
  const report = (source, query, status, count = 0, error) => { feeds.push({ source, query, status, count, error, fetchedAt: new Date().toISOString() }); onProgress({ source, topic: query, status, count }); };
  // Intent queries reach across the full topic space rather than collecting generic mentions.
  for (const query of INTENTS) {
    for (let page = 0; page < 2; page++) {
      try {
        const result = await publicFetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=comment&hitsPerPage=100&page=${page}&numericFilters=created_at_i%3E${cutoff}`);
        const found = (result.hits || []).map(hnRecord).filter(Boolean); records.push(...found); report('hn', `${query} · ${page + 1}`, 'ok', found.length);
        if ((result.hits || []).length < 100) break;
      } catch (error) { report('hn', query, 'error', 0, error.message); break; }
    }
  }
  for (const query of ['tool', 'software', 'automation', 'AI', 'alternative']) {
    try { const result = await publicFetch(`https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=ask_hn&hitsPerPage=100&numericFilters=created_at_i%3E${cutoff}`); const found = (result.hits || []).map(hnRecord).filter(Boolean); records.push(...found); report('hn', `Ask HN: ${query}`, 'ok', found.length); }
    catch (error) { report('hn', query, 'error', 0, error.message); }
  }
  const githubTopics = TOPICS.filter(t => t.repo);
  for (const [index, topic] of githubTopics.entries()) {
    const repos = [topic.repo, ...(EXTRA_REPOS[topic.id] || [])];
    const query = `is:issue is:open ${repos.map(repo => `repo:${repo}`).join(' ')} "feature" in:title -label:documentation`;
    try {
      const result = await publicFetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`);
      const found = (result.items || []).map(hit => githubRecord(hit, topic.id)).filter(Boolean); records.push(...found); githubHits.push(...(result.items || []).filter(h => h.comments > 3).map(h => ({ ...h, topicId: topic.id })));
      report('github', topic.name, 'ok', found.length);
    } catch (error) { report('github', topic.name, 'error', 0, error.message); }
    if (index < githubTopics.length - 1) await wait(6500);
  }
  // Comments remain separate authored records; reactions never become request counts.
  for (const parent of githubHits.sort((a, b) => b.comments - a.comments).slice(0, 6)) {
    try {
      const comments = await publicFetch(`${parent.url}/comments?per_page=100&sort=created&direction=desc`);
      let count = 0;
      for (const comment of comments) {
        if (!comment.user || comment.user.type === 'Bot') continue;
        const text = plainText(comment.body); if (text.length < 10) continue;
        records.push({ ...githubRecord({ ...parent, id: `comment:${comment.id}`, title: parent.title, body: text, user: comment.user, html_url: comment.html_url, url: comment.url, created_at: comment.created_at, updated_at: comment.updated_at }, parent.topicId), threadUrl: parent.html_url, parentApiUrl: parent.url, recordType: 'comment' }); count++;
      }
      report('github', `Comments: ${parent.title}`, 'ok', count);
    } catch (error) { report('github', parent.title, 'error', 0, error.message); }
  }
  const redditQuery = '"looking for" OR "I wish" OR "feature request" OR "need a tool" OR "is there a"';
  for (const subreddit of SUBREDDITS) {
    try {
      const found = await redditFeed(`https://www.reddit.com/r/${subreddit}/search.rss?q=${encodeURIComponent(redditQuery)}&restrict_sr=on&sort=new&t=year&limit=100`);
      records.push(...found); report('reddit', `r/${subreddit}`, 'ok', found.length);
    } catch (error) { report('reddit', `r/${subreddit}`, 'error', 0, error.message); }
    await wait(900);
  }
  for (let page = 1; page <= 5; page++) {
    try {
      const result = await publicFetch(`https://api.stackexchange.com/2.3/questions?site=softwarerecs&pagesize=100&page=${page}&sort=creation&order=desc&filter=withbody`);
      const found = (result.items || []).map(stackRecord).filter(Boolean); records.push(...found); report('stackexchange', `Software Recommendations · ${page}`, 'ok', found.length);
      if (result.backoff) await wait(Math.min(60000, result.backoff * 1000));
      if (!result.has_more || result.quota_remaining < 5) break;
    } catch (error) { report('stackexchange', 'Software Recommendations', 'error', 0, error.message); break; }
  }
  const canonical = new Map();
  for (const record of dedupe(records)) {
    const key = canonicalSourceUrl(record.url) || record.id;
    canonical.set(key, { ...record, request: detectRequest(record) });
  }
  const final = [...canonical.values()];
  return { version: 2, fetchedAt: new Date().toISOString(), topics: TOPICS, records: final, feeds, status: TOPICS.map(topic => ({ topicId: topic.id, hn: feeds.some(f => f.source === 'hn' && f.status === 'ok') ? 'ok' : 'Unavailable', github: topic.repo ? feeds.find(f => f.source === 'github' && f.query === topic.name)?.status === 'ok' ? 'ok' : 'Unavailable' : 'ok' })), coverage: { reddit: 'public-rss', redditFeedEnds: '2026-11-13', x: 'not-connected', linkedin: 'dataset-import', bluesky: 'unavailable-403' } };
}
