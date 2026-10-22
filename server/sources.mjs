import { XMLParser } from 'fast-xml-parser';
import { TOPICS, plainText, tokens } from './data.mjs';
import { detectRequest, SOFTWARE } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

const AGENT = 'InternetAtlas/0.2 public research; local single-user prototype';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SOURCE_SOFTWARE = /\b(?:chatgpt|claude|pdf|full.?text|bookmarks?|read.?later|caldav|outlook|wallabag|linkding|readwise)\b/i;

// Quoting another user's request does not make it the current author's request.
export function authoredPlainText(value = '') {
  let html = String(value);
  for (let pass = 0; pass < 2; pass++) html = html.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  let depth = 0, start = 0, unquoted = '';
  for (const match of html.matchAll(/<\/?blockquote\b[^>]*>/gi)) {
    if (!/^<\//.test(match[0])) {
      if (depth === 0) unquoted += `${html.slice(start, match.index)}\n[Quoted passage omitted]\n`;
      depth++;
    } else if (depth > 0 && --depth === 0) start = match.index + match[0].length;
  }
  if (!depth) unquoted += html.slice(start);
  return unquoted.split(/<p(?:\s[^>]*)?>|<\/p>|<br\s*\/?>|\r?\n/gi).map(part => {
    const text = plainText(part);
    return /^\s*>/.test(text) ? '[Quoted passage omitted]' : text;
  }).filter(Boolean).join('\n\n').trim();
}

export function topicFor(text) {
  const words = new Set(tokens(text));
  const ranked = TOPICS.filter(t => t.id !== 'software').map(t => ({ id: t.id, score: t.terms.reduce((sum, term) => sum + (words.has(term) || words.has(term + 's') ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].id : 'software';
}
export function hnRecord(hit) {
  const originalHtml = String(hit.comment_text || hit.story_text || ''), title = plainText(hit.story_title || hit.title || 'Hacker News');
  const isComment = (hit._tags || []).includes('comment') || hit.comment_text !== undefined && hit.comment_text !== null || hit.story_id && String(hit.story_id) !== String(hit.objectID);
  let text = authoredPlainText(originalHtml), textScope = 'authored-unquoted';
  if (!isComment && text.length < 25 && /^ask hn\s*:/i.test(title)) { text = title; textScope = 'title-only'; }
  if (!/^\d+$/.test(String(hit.objectID)) || !hit.author || hit.author === '[deleted]' || text.length < 25 || !Number.isFinite(Date.parse(hit.created_at)) || !SOFTWARE.test(`${title} ${text}`) && !SOURCE_SOFTWARE.test(`${title} ${text}`)) return null;
  return { id: `hn:${hit.objectID}`, source: 'hn', topicId: topicFor(`${title} ${text}`), title, text: text.slice(0, 6000), author: hit.author, authorId: `hn:${hit.author}`, profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}`, url: `https://news.ycombinator.com/item?id=${hit.objectID}`, threadUrl: `https://news.ycombinator.com/item?id=${hit.story_id || hit.objectID}`, date: hit.created_at, fetchedAt: new Date().toISOString(), status: 'public', replies: hit.num_comments || 0, recordType: isComment ? 'comment' : 'post', origin: 'live-api', originalHtml: originalHtml.slice(0, 24000), textScope };
}

export function githubRecord(hit, topicId) {
  const text = authoredPlainText(hit.body || hit.title);
  if (!hit.user?.login || hit.user.type === 'Bot' || text.length < 30) return null;
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
    const text = authoredPlainText(String(raw).replace(/\s+submitted by\s+[\s\S]*$/i, ''));
    const date = String(entry.published || entry.updated || '');
    if (!text || /^\[(?:removed|deleted)\]$/i.test(text) || !Number.isFinite(Date.parse(date)) || !SOFTWARE.test(`${title} ${text}`) && !SOURCE_SOFTWARE.test(`${title} ${text}`)) return [];
    return [{ id: `reddit:${entry.id}`, source: 'reddit', topicId: topicFor(`${title} ${text}`), title, text: text.slice(0, 6000), author, authorId: `reddit:${author.toLowerCase()}`, profileUrl: `https://www.reddit.com/user/${encodeURIComponent(author)}/`, url: link, threadUrl: link, date, fetchedAt: new Date().toISOString(), status: 'public', replies: 0, community: String(entry.category?.['@_term'] || parsed.feed.category?.['@_term'] || ''), recordType: 'post', origin: 'public-feed', originalHtml: String(raw).slice(0, 24000), textScope: 'authored-unquoted' }];
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
  const title = plainText(hit.title), text = authoredPlainText(hit.body);
  return { id: `stackexchange:${hit.question_id}`, source: 'stackexchange', topicId: topicFor(`${title} ${text} ${(hit.tags || []).join(' ')}`), title, text: text.slice(0, 6000), author: plainText(hit.owner.display_name), authorId: `stackexchange:${hit.owner.user_id}`, profileUrl: hit.owner.link || hit.link, url: hit.link, threadUrl: hit.link, apiUrl: `https://api.stackexchange.com/2.3/questions/${hit.question_id}?site=softwarerecs&filter=withbody`, date: new Date(hit.creation_date * 1000).toISOString(), fetchedAt: new Date().toISOString(), status: hit.closed_date ? 'closed' : 'public', replies: hit.answer_count || 0, labels: hit.tags || [], recordType: 'post', origin: 'live-api', license: hit.content_license || 'CC BY-SA', licenseUrl: 'https://stackoverflow.com/help/licensing', originalHtml: String(hit.body).slice(0, 24000), textScope: 'authored-unquoted' };
}

// Families describe workflows. Every candidate still needs an authored, explicit ask.
export const PROBLEM_FAMILIES = [
  { id: 'webhooks', name: 'webhook reliability', match: /webhook|event delivery/i, terms: ['webhook', 'webhook retry', 'webhook duplicate', 'webhook replay'], subreddits: ['n8n', 'SaaS', 'selfhosted'], repos: ['n8n-io/n8n', 'triggerdotdev/trigger.dev'], github: 'webhook', topicId: 'integrations' },
  { id: 'memory', name: 'agent memory', match: /agent.*memor|memor.*agent|persistent.*context/i, terms: ['agent memory', 'persistent memory', 'agent context', 'conversation history'], subreddits: ['AI_Agents', 'LocalLLaMA', 'LangChain'], repos: ['langchain-ai/langgraph', 'mem0ai/mem0', 'langchain-ai/langchain'], github: 'memory', topicId: 'agents' },
  { id: 'offline', name: 'local offline software', match: /offline|local.first|local software/i, terms: ['offline software', 'local first', 'offline app', 'self hosted alternative'], subreddits: ['selfhosted', 'software', 'ObsidianMD'], repos: ['logseq/logseq', 'AppFlowy-IO/AppFlowy'], github: 'offline', topicId: 'software' },
  { id: 'tests', name: 'flaky tests', match: /flaky|flakiness|test reliab/i, terms: ['flaky tests', 'test flakiness', 'flaky test', 'test retries'], subreddits: ['QualityAssurance', 'webdev', 'softwaretesting'], repos: ['microsoft/playwright', 'vitest-dev/vitest', 'cypress-io/cypress'], github: 'flaky', topicId: 'testing' },
  { id: 'documents', name: 'document search', match: /document.*search|search.*document|pdf.*search|search.*pdf/i, terms: ['document search', 'search pdf', 'search documents', 'semantic search'], subreddits: ['selfhosted', 'software', 'LocalLLaMA'], repos: ['Mintplex-Labs/anything-llm', 'open-webui/open-webui', 'run-llama/llama_index'], github: 'search', topicId: 'retrieval' },
  { id: 'calendar', name: 'calendar scheduling', match: /calendar|scheduling|meeting sched/i, terms: ['calendar scheduling', 'meeting scheduling', 'calendar sync', 'scheduling tool'], subreddits: ['selfhosted', 'software', 'smallbusiness'], repos: ['calcom/cal.diy'], github: 'scheduling', topicId: 'software' },
  { id: 'billing', name: 'subscription billing', match: /billing|subscription|invoice/i, terms: ['subscription billing', 'usage based billing', 'invoice automation', 'billing software'], subreddits: ['SaaS', 'smallbusiness', 'selfhosted'], repos: ['getlago/lago', 'polar-sh/polar'], github: 'billing', topicId: 'billing' },
  { id: 'permissions', name: 'internal permissions', match: /permission|role.based|access control/i, terms: ['fine grained permissions', 'role based access', 'access control', 'permissions management'], subreddits: ['selfhosted', 'SaaS', 'webdev'], repos: ['supabase/auth', 'better-auth/better-auth', 'appwrite/appwrite'], github: 'permission', topicId: 'auth' },
];

export function problemQueryPlan(query, options = {}) {
  const cleaned = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (cleaned.length < 3) throw new Error('Use a specific problem to collect requests.');
  const known = PROBLEM_FAMILIES.find(family => family.match.test(cleaned));
  const terms = [...new Set(known ? [cleaned, ...known.terms] : [cleaned, `${cleaned} alternative`, `${cleaned} workaround`, `${cleaned} feature request`])].slice(0, 5);
  const pages = Math.max(1, Math.min(3, Math.floor(Number(options.pages) || 2)));
  return { query: cleaned, family: known?.id || 'custom', terms, pages, subreddits: known?.subreddits || ['selfhosted', 'software', 'SaaS'], repos: known?.repos || [], github: known?.github || cleaned, topicId: known?.topicId || topicFor(cleaned) };
}

const PROVIDERS = new Set(['hn', 'reddit', 'stackexchange', 'github']);
const PROVIDER_HOSTS = { hn: 'hn.algolia.com', reddit: 'www.reddit.com', stackexchange: 'api.stackexchange.com', github: 'api.github.com' };
const REQUEST_INTENTS = '("looking for" OR "I wish" OR "I need" OR "feature request" OR "is there" OR "alternative")';

export function checkCollectionCancelled(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException(typeof signal.reason === 'string' ? signal.reason : 'Request collection cancelled', 'AbortError');
}

function retryDelay(response, now) {
  const value = response.headers.get('retry-after');
  if (!value) return 1000;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : Math.max(1000, Date.parse(value) - now || 1000);
}

// Provider state can be shared across multiple problem collections in one run.
export function createPublicCollectorClient(options = {}) {
  const fetcher = options.fetch || fetch, sleep = options.sleep || wait, now = options.now || Date.now;
  const state = options.rateState || {}, signal = options.signal, attempts = options.attempts || [];
  const disabled = provider => {
    const current = state[provider];
    if (options.resumeAfterBackoff && current?.resumeAt && current.resumeAt <= now()) { delete current.disabled; delete current.resumeAt; }
    return current?.disabled;
  };
  async function request(provider, url, format = 'json') {
    checkCollectionCancelled(signal);
    const parsed = new URL(url);
    if (!PROVIDERS.has(provider) || parsed.protocol !== 'https:' || parsed.hostname !== PROVIDER_HOSTS[provider]) throw new Error('Unsupported collection endpoint');
    const current = state[provider] ||= { nextAt: 0, requests: 0 };
    if (disabled(provider)) throw new Error(current.disabled);
    if (current.nextAt > now()) {
      const delay = current.nextAt - now();
      if (delay > 60000) throw new Error(`${provider} is in backoff until ${new Date(current.nextAt).toISOString()}`);
      await sleep(delay); checkCollectionCancelled(signal);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCollectionCancelled(signal);
      const started = now(), entry = { provider, url, startedAt: new Date(started).toISOString(), retry: attempt, status: null, ok: false };
      attempts.push(entry);
      const headers = { 'User-Agent': AGENT, Accept: format === 'xml' ? 'application/atom+xml' : 'application/json' };
      if (provider === 'github' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const interval = options.intervals?.[provider] ?? (provider === 'github' && parsed.pathname === '/search/issues' ? 6500 : provider === 'reddit' ? 1100 : 200);
      try {
        const timeout = AbortSignal.timeout(20000);
        const response = await fetcher(url, { headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        checkCollectionCancelled(signal); current.requests++;
        entry.status = response.status;
        for (const [header, field] of [['x-ratelimit-remaining', 'rateRemaining'], ['x-ratelimit-reset', 'rateReset']]) if (response.headers.get(header) !== null) entry[field] = response.headers.get(header);
        current.nextAt = now() + interval;
        if (response.status === 401 || response.status === 403) {
          current.disabled = `${provider}: HTTP ${response.status}; collection stopped for this run`;
          throw new Error(current.disabled);
        }
        if (response.status === 429 || response.status >= 500) {
          const delay = retryDelay(response, now()); entry.retryAfterMs = delay;
          current.nextAt = Math.max(current.nextAt, now() + delay);
          if (!attempt && delay <= 10000) {
            entry.error = `${provider}: HTTP ${response.status}`;
            await sleep(Math.max(delay, interval)); checkCollectionCancelled(signal); continue;
          }
          if (response.status === 429) { current.resumeAt = current.nextAt; current.disabled = `${provider}: HTTP 429; retry after ${new Date(current.nextAt).toISOString()}`; }
          throw new Error(current.disabled || `${provider}: HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(`${provider}: HTTP ${response.status}`);
        if (provider === 'github' && response.headers.get('x-ratelimit-remaining') === '0') current.disabled = `github: rate limit exhausted; resets ${new Date(Number(response.headers.get('x-ratelimit-reset')) * 1000).toISOString()}`;
        if (format === 'xml') {
          const xml = await response.text(); checkCollectionCancelled(signal);
          const result = parseRedditFeed(xml); entry.rawCount = (xml.match(/<entry\b/g) || []).length; entry.normalizedCount = result.length; entry.ok = true; return result;
        }
        const data = await response.json(); checkCollectionCancelled(signal);
        if (data.backoff) { entry.backoffMs = Number(data.backoff) * 1000; current.nextAt = Math.max(current.nextAt, now() + entry.backoffMs); }
        if (data.quota_remaining !== undefined) entry.quotaRemaining = data.quota_remaining;
        if (provider === 'stackexchange' && data.quota_remaining !== undefined && data.quota_remaining < 5) current.disabled = 'stackexchange: daily quota nearly exhausted; collection stopped for this run';
        if (data.error_id) throw new Error(`${provider}: ${data.error_name || data.error_id}: ${data.error_message || 'API error'}`);
        entry.rawCount = (data.hits || data.items || (Array.isArray(data) ? data : [])).length;
        if (data.nbHits !== undefined) entry.totalHits = data.nbHits;
        entry.ok = true; return data;
      } catch (error) {
        entry.error = error.message || String(error); checkCollectionCancelled(signal); throw error;
      } finally { entry.completedAt = new Date(now()).toISOString(); entry.durationMs = Math.max(0, now() - started); }
    }
  }
  return { request, disabled, attempts, state };
}

export async function collectProblemRequests(query, previous = { records: [] }, onProgress = () => {}, options = {}) {
  const signal = options.signal;
  checkCollectionCancelled(signal);
  const plan = problemQueryPlan(query, options), client = createPublicCollectorClient(options);
  const providers = new Set(options.providers || ['hn', 'reddit', 'stackexchange', 'github']);
  for (const provider of providers) if (!PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider}`);
  const startedAt = new Date().toISOString(), cutoff = Math.floor(Date.now() / 1000) - Math.max(30, Math.min(3650, Number(options.sinceDays) || 365)) * 86400;
  const canonical = new Map((previous.records || []).map(record => [canonicalSourceUrl(record.url) || record.id, record]));
  const feeds = [...(previous.feeds || [])], collection = { query: plan.query, family: plan.family, startedAt, examined: 0, accepted: 0, added: 0, duplicates: 0, rejected: 0, sources: {}, errors: [] };
  const report = (source, search, status, count, error, page) => {
    const entry = { source, query: search, problem: plan.query, status, count, error, page, fetchedAt: new Date().toISOString() };
    checkCollectionCancelled(signal);
    feeds.push(entry); onProgress({ phase: 'collecting', ...entry });
    checkCollectionCancelled(signal);
    if (error) collection.errors.push({ source, query: search, error });
  };
  function accept(found, source, search, page, endpoint) {
    checkCollectionCancelled(signal);
    let accepted = 0;
    for (const record of found) {
      if (!record) continue;
      collection.examined++;
      const request = detectRequest(record);
      if (!request || request.type === 'endorsement') { collection.rejected++; continue; }
      const key = canonicalSourceUrl(record.url);
      if (!key || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > Date.now()) { collection.rejected++; continue; }
      accepted++; collection.accepted++;
      const provenance = { problem: plan.query, family: plan.family, query: search, endpoint, page, collectedAt: new Date().toISOString() };
      const existing = canonical.get(key);
      if (existing) {
        collection.duplicates++;
        // Keep stable source IDs because saved ideas and citations refer to them.
        canonical.set(key, { ...existing, ...record, id: existing.id, request, collection: existing.collection || provenance });
      } else {
        canonical.set(key, { ...record, request, collection: provenance }); collection.added++;
        collection.sources[source] = (collection.sources[source] || 0) + 1;
      }
    }
    return accepted;
  }
  if (providers.has('hn')) for (const search of plan.terms) {
    if (client.disabled('hn')) break;
    for (let page = 0; page < plan.pages; page++) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(search)}&tags=(comment,ask_hn)&hitsPerPage=100&page=${page}&numericFilters=created_at_i%3E${cutoff}`;
      try {
        const data = await client.request('hn', url), hits = data.hits || [];
        const count = accept(hits.map(hnRecord).filter(Boolean), 'hn', search, page + 1, url);
        report('hn', search, 'ok', count, undefined, page + 1);
        if (hits.length < 100 || page + 1 >= Number(data.nbPages || Infinity)) break;
      } catch (error) { checkCollectionCancelled(signal); report('hn', search, 'error', 0, error.message, page + 1); break; }
    }
  }
  if (providers.has('reddit')) {
    const searches = [{ scope: '', search: `(${plan.terms.slice(0, 3).map(term => `"${term}"`).join(' OR ')}) AND ${REQUEST_INTENTS}` }, ...plan.subreddits.map(scope => ({ scope, search: plan.terms.slice(0, 2).map(term => `"${term}"`).join(' OR ') }))];
    for (const { scope, search } of searches) {
      if (client.disabled('reddit')) break;
      const url = `https://www.reddit.com/${scope ? `r/${scope}/` : ''}search.rss?q=${encodeURIComponent(search)}&${scope ? 'restrict_sr=on&' : ''}sort=relevance&t=year&limit=100`;
      try { const found = await client.request('reddit', url, 'xml'); report('reddit', scope ? `r/${scope}: ${search}` : search, 'ok', accept(found, 'reddit', search, 1, url), undefined, 1); }
      catch (error) { checkCollectionCancelled(signal); report('reddit', search, 'error', 0, error.message, 1); }
    }
  }
  if (providers.has('stackexchange')) for (const search of plan.terms.slice(0, 2)) {
    if (client.disabled('stackexchange')) break;
    for (let page = 1; page <= plan.pages; page++) {
      const url = `https://api.stackexchange.com/2.3/search/advanced?site=softwarerecs&q=${encodeURIComponent(search)}&pagesize=100&page=${page}&sort=relevance&order=desc&filter=withbody&fromdate=${cutoff}`;
      try {
        const data = await client.request('stackexchange', url), hits = data.items || [];
        report('stackexchange', search, 'ok', accept(hits.map(stackRecord).filter(Boolean), 'stackexchange', search, page, url), undefined, page);
        if (!data.has_more || client.disabled('stackexchange')) break;
      } catch (error) { checkCollectionCancelled(signal); report('stackexchange', search, 'error', 0, error.message, page); break; }
    }
  }
  if (providers.has('github') && plan.repos.length && !client.disabled('github')) {
    const search = `is:issue is:open ${plan.repos.map(repo => `repo:${repo}`).join(' ')} ${plan.github} in:title -label:documentation`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(search)}&sort=comments&order=desc&per_page=100`;
    try {
      const data = await client.request('github', url), hits = data.items || [];
      report('github', search, 'ok', accept(hits.map(hit => githubRecord(hit, plan.topicId)).filter(Boolean), 'github', search, 1, url), undefined, 1);
      // Read authored requests within issues, never convert reactions into people.
      for (const parent of hits.filter(hit => hit.comments > 1).slice(0, 2)) {
        if (client.disabled('github')) break;
        const endpoint = `${parent.url}/comments?per_page=100`;
        try {
          const comments = await client.request('github', endpoint);
          const found = comments.filter(comment => comment.user && comment.user.type !== 'Bot').map(comment => ({ ...githubRecord({ ...parent, id: `comment:${comment.id}`, body: comment.body, user: comment.user, html_url: comment.html_url, url: comment.url, created_at: comment.created_at, updated_at: comment.updated_at }, plan.topicId), threadUrl: parent.html_url, parentApiUrl: parent.url, recordType: 'comment' })).filter(record => record.id);
          report('github', `Comments: ${parent.title}`, 'ok', accept(found, 'github', search, 1, endpoint), undefined, 1);
        } catch (error) { checkCollectionCancelled(signal); report('github', `Comments: ${parent.title}`, 'error', 0, error.message, 1); }
      }
    } catch (error) { checkCollectionCancelled(signal); report('github', search, 'error', 0, error.message, 1); }
  }
  checkCollectionCancelled(signal);
  if (!feeds.slice(previous.feeds?.length || 0).some(feed => feed.status === 'ok')) throw new Error(`No public providers returned data. Existing atlas was kept. ${collection.errors.map(error => error.error).join('; ')}`);
  collection.completedAt = new Date().toISOString();
  onProgress({ phase: 'collected', ...collection });
  checkCollectionCancelled(signal);
  return { ...previous, version: 3, records: [...canonical.values()], feeds: feeds.slice(-500), fetchedAt: collection.completedAt, collection, collections: [...(previous.collections || []), collection].slice(-40) };
}

export async function collectRequests(query, previous, onProgress = () => {}, options = {}) {
  return collectProblemRequests(query, previous, onProgress, options);
}

export async function ingestPublic(onProgress = () => {}, previous = { records: [] }) {
  let corpus = { ...previous, topics: TOPICS }, rateState = {}, successful = 0;
  const failures = [];
  for (const family of PROBLEM_FAMILIES) {
    try { corpus = await collectProblemRequests(family.name, corpus, onProgress, { rateState }); successful++; }
    catch (error) { failures.push(error.message); onProgress({ source: 'collection', topic: family.name, status: 'error', error: error.message }); }
  }
  if (!successful) throw new Error(`Public collection failed. Existing atlas was kept. ${failures[0] || ''}`);
  return { ...corpus, topics: TOPICS, status: TOPICS.map(topic => ({ topicId: topic.id, hn: corpus.feeds?.some(feed => feed.source === 'hn' && feed.status === 'ok') ? 'ok' : 'Unavailable', github: corpus.feeds?.some(feed => feed.source === 'github' && feed.status === 'ok') ? 'ok' : 'Unavailable' })), coverage: { reddit: 'public-rss', redditFeedEnds: '2026-11-13', x: 'not-connected', linkedin: 'dataset-import', bluesky: 'unavailable-403' } };
}
