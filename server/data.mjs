import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { citedSourceIds } from '../shared/citations.mjs';
import { recountSignals, embedTexts, cosine } from './signals.mjs';
import { requestFor, attributableSource } from './requests.mjs';
import { shortlistSourceIds, updateShortlists } from './shortlists.mjs';
import { browserCorpus } from '../shared/state-transport.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
export const TOPICS = [
  { id: 'agents', name: 'Agent reliability', color: '#b5a1ec', query: 'agent memory', repo: 'langchain-ai/langgraph', terms: ['agent', 'memory', 'checkpoint', 'langgraph', 'state', 'workflow'] },
  { id: 'retrieval', name: 'Search & retrieval', color: '#77bda3', query: 'RAG', repo: 'run-llama/llama_index', terms: ['rag', 'retrieval', 'search', 'embedding', 'document', 'index'] },
  { id: 'data', name: 'Data infrastructure', color: '#d0ad74', query: 'database migration', repo: 'prisma/orm', terms: ['database', 'migration', 'schema', 'sql', 'prisma', 'data'] },
  { id: 'testing', name: 'Testing & CI', color: '#7daee0', query: 'flaky tests', repo: 'microsoft/playwright', terms: ['test', 'testing', 'flaky', 'ci', 'playwright', 'browser'] },
  { id: 'observability', name: 'Observability', color: '#de8b93', query: 'observability', repo: 'open-telemetry/opentelemetry-collector-contrib', terms: ['observability', 'trace', 'tracing', 'log', 'monitoring', 'telemetry'] },
  { id: 'integrations', name: 'Integrations', color: '#93b6c4', query: 'API integration', repo: 'n8n-io/n8n', terms: ['integration', 'api', 'webhook', 'automation', 'n8n', 'connector'] },
  { id: 'auth', name: 'Identity & access', color: '#c894b7', query: 'authentication', repo: 'supabase/auth', terms: ['auth', 'authentication', 'oauth', 'login', 'permission', 'session'] },
  { id: 'billing', name: 'Billing & payments', color: '#bccb87', query: 'billing', repo: 'getlago/lago', terms: ['billing', 'payment', 'subscription', 'invoice', 'pricing', 'stripe'] },
  { id: 'software', name: 'Software requests', color: '#b4b1a0', query: 'software', repo: '', terms: ['software', 'tool', 'app', 'desktop', 'product', 'self-hosted'] },
];

export function plainText(input = '') {
  return String(input).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) <= 0x10ffff ? Number(n) : 32))
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) <= 0x10ffff ? parseInt(n, 16) : 32)).replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
export const tokens = text => plainText(text).toLowerCase().match(/[a-z0-9][a-z0-9_+-]{2,}/g) || [];
const STOP = new Set('the and for that this with from are have has was were you your not but can all would could should they their how what our will into about use using used also just when there more than some like been one any its get does which need want make'.split(' '));
const keywords = text => [...new Set(tokens(text).filter(t => !STOP.has(t)))];
const profileText = value => value == null || value === 'null' ? null : plainText(value) || null;
const publicProfile = profile => ({ ...profile, bio: profileText(profile.bio), company: profileText(profile.company) });
export function matchesCollection(topic, text) {
  const words = tokens(text);
  return keywords(topic.query).every(term => {
    const stem = term.endsWith('s') ? term.slice(0, -1) : term;
    return words.some(word => word.startsWith(stem));
  });
}
export function dedupe(records) { return [...new Map(records.filter(r => r.id && r.url && r.author && r.text).map(r => [r.id, r])).values()]; }

export async function publicFetch(url) {
  const parsed = new URL(url);
  if (!['api.github.com', 'hn.algolia.com', 'hacker-news.firebaseio.com', 'api.stackexchange.com'].includes(parsed.hostname) || parsed.protocol !== 'https:') throw new Error('Unsupported data source');
  const headers = { 'User-Agent': 'Internet-Atlas-local/0.1', Accept: 'application/json' };
  if (parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(18000), redirect: 'error' });
  if (!response.ok) throw new Error(`${parsed.hostname}: HTTP ${response.status}`);
  return response.json();
}

export async function ingest(onProgress = () => {}, previous = { records: [] }) {
  const { ingestPublic } = await import('./sources.mjs');
  return ingestPublic(onProgress, previous);
}

export function searchRecords(corpus, query, limit = 18, topicId) {
  const terms = keywords(query);
  const result = corpus.records.filter(r => !topicId || r.topicId === topicId).map(record => {
    const title = new Set(tokens(record.title)), body = new Set(tokens(record.text));
    const topic = TOPICS.find(t => t.id === record.topicId);
    let score = terms.reduce((n, t) => n + (title.has(t) ? 4 : 0) + (body.has(t) ? 1 : 0) + (topic?.terms.includes(t) ? 0.35 : 0), 0);
    return { ...record, score };
  }).filter(r => !terms.length || r.score > 0).sort((a, b) => b.score - a.score || Date.parse(b.updatedAt || b.date) - Date.parse(a.updatedAt || a.date));
  return result.slice(0, Math.max(1, Math.min(100, limit)));
}

const unavailableLeadSource = (record, now = Date.now()) => !attributableSource(record) || typeof record.authorId !== 'string' || !record.authorId || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > now;
const normalizedQuote = value => String(value || '').replace(/\s+/g, ' ').trim();
const accountId = record => {
  const id = record.authorId.startsWith(`${record.source}:`) ? record.authorId : `${record.source}:${record.authorId}`;
  return ['github', 'reddit', 'x'].includes(record.source) ? id.toLowerCase() : id;
};
const reviewedProblems = corpus => (corpus.signals || []).filter(group => group.reviewed && group.id && Array.isArray(group.sourceIds) && (group.confidence === undefined || group.confidence >= .65));

export function selectedProblemIds(corpus, idea) {
  const groups = new Map(reviewedProblems(corpus).map(group => [group.id, group]));
  const attached = new Set(Array.isArray(idea.sourceIds) ? idea.sourceIds : []);
  const inferred = corpus.records.filter(record => attached.has(record.id) && groups.get(record.signalId)?.sourceIds.includes(record.id)).map(record => record.signalId);
  return [...new Set([...(Array.isArray(idea.problemIds) ? idea.problemIds : []), ...inferred])].filter(id => groups.has(id));
}

function eligibleRequest(record, now) {
  if (unavailableLeadSource(record, now)) return null;
  const request = requestFor(record);
  if (!request || request.type === 'endorsement') return null;
  const quote = normalizedQuote(request.quote);
  if (!quote || ![record.title, record.text].some(text => normalizedQuote(text).includes(quote))) return null;
  return request;
}

function requesterLeads(corpus, idea, problemMatches, limit, now) {
  const records = new Map(corpus.records.map(record => [record.id, record]));
  const problems = new Map(reviewedProblems(corpus).map(group => [group.id, group]));
  const byAuthor = new Map();
  for (const match of problemMatches) {
    const group = problems.get(match.problemId);
    if (!group) continue;
    for (const sourceId of new Set(group.sourceIds)) {
      const record = records.get(sourceId);
      if (!record) continue;
      const request = eligibleRequest(record, now);
      if (!request) continue;
      const id = accountId(record);
      const score = (match.matchKind === 'selected-problem' ? 1000 : match.similarity * 100) + (record.problemAnalysis?.confidence || .65) + Math.max(0, 1 - (now - Date.parse(record.date)) / (365 * 86400000));
      const evidence = { sourceId, quote: request.quote, problemId: group.id, date: record.date, url: record.url };
      const existing = byAuthor.get(id);
      if (existing) {
        if (!existing.sourceIds.includes(sourceId)) { existing.sourceIds.push(sourceId); existing.requestEvidence.push(evidence); }
        if (!existing.problemIds.includes(group.id)) existing.problemIds.push(group.id);
        existing.rank = Math.max(existing.rank, score);
        if (match.similarity !== undefined) existing.matchScore = Math.max(existing.matchScore || 0, match.similarity);
      } else byAuthor.set(id, { id, name: record.author, source: record.source, profileUrl: record.profileUrl || record.url, sourceIds: [sourceId], rank: score, topicId: record.topicId, ideaRevision: idea.revision, kind: 'Requester', problemIds: [group.id], matchKind: match.matchKind, ...(match.similarity === undefined ? {} : { matchScore: match.similarity }), evidenceQuote: request.quote, requestEvidence: [evidence] });
    }
  }
  return [...byAuthor.values()].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).slice(0, limit).map(({ rank, ...lead }) => lead);
}

/** Semantic retrieval identifies candidate problems, never creates request evidence or purchase intent. */
export async function matchIdeaProblems(corpus, idea, directory, { embed = embedTexts, threshold = .58, limit = 5 } = {}) {
  const groups = reviewedProblems(corpus);
  if (!groups.length) return [];
  const texts = [`${idea.title}. ${idea.description || ''}`, ...groups.map(group => `${group.workflow || group.label}. ${group.problem || group.label}. Desired outcome: ${group.desiredOutcome || group.label}`)];
  const vectors = await embed(texts, directory);
  if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors[0]?.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== vectors[0].length || vector.some(value => !Number.isFinite(value)))) throw new Error('Local semantic matching returned invalid vectors.');
  return groups.map((group, index) => ({ problemId: group.id, similarity: cosine(vectors[0], vectors[index + 1]), matchKind: 'semantic-problem' })).filter(match => match.similarity >= threshold).sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(1, Math.min(20, limit)));
}

/** Legacy keyword evidence stays labeled; analyzed nonrequests can never become requesters. */
function keywordLeads(corpus, idea, limit, now, requestOnly) {
  const evidence = corpus.records.filter(r => idea.sourceIds.includes(r.id));
  const inferredTopic = idea.topicId || evidence[0]?.topicId;
  const ranked = searchRecords(corpus, `${idea.title} ${idea.description}`, 100, undefined);
  const byAuthor = new Map();
  const titleTerms = keywords(idea.title);
  const relatedSignals = new Set(evidence.map(record => record.signalId).filter(Boolean));
  for (const record of ranked) {
    if (unavailableLeadSource(record, now) || record.problemAnalysis && (record.problemAnalysis.classification !== 'request' || record.problemAnalysis.requesterRole === 'vendor' || record.problemAnalysis.confidence < .65)) continue;
    const request = eligibleRequest(record, now);
    if (requestOnly && !request) continue;
    const recordWords = new Set(tokens(`${record.title} ${record.text}`));
    const titleOverlap = titleTerms.filter(t => recordWords.has(t)).length;
    if (!titleOverlap && record.score < 3) continue;
    const sharesTool = /\b(?:i (?:am|'m) the founder|i (?:built|created|launched)|we (?:built|created|launched)|our (?:tool|product|platform))\b/i.test(record.text);
    const kind = request ? 'Requester' : sharesTool ? 'Shares a tool' : record.source === 'github' ? 'Issue author' : 'Discussant';
    const score = (record.score + titleOverlap * 3 + (record.topicId === inferredTopic ? 1 : 0) + (record.request ? 3 : 0) + (relatedSignals.has(record.signalId) ? 8 : 0)) * (sharesTool ? .25 : 1);
    if (score < 1) continue;
    const id = accountId(record), existing = byAuthor.get(id);
    if (existing) { existing.sourceIds.push(record.id); existing.rank += score * 0.15; }
    else byAuthor.set(id, { id, name: record.author, source: record.source, profileUrl: record.profileUrl, sourceIds: [record.id], rank: score, topicId: record.topicId, ideaRevision: idea.revision, kind, problemIds: [], matchKind: request ? 'keyword-request' : 'keyword-evidence', ...(request ? { evidenceQuote: request.quote, requestEvidence: [{ sourceId: record.id, quote: request.quote, problemId: null, date: record.date, url: record.url }] } : {}) });
  }
  return [...byAuthor.values()].sort((a, b) => b.rank - a.rank).slice(0, limit).map(({ rank, ...lead }) => lead);
}

export function rankLeads(corpus, idea, limit, { problemMatches = [], now = Date.now() } = {}) {
  const selected = selectedProblemIds(corpus, idea).map(problemId => ({ problemId, matchKind: 'selected-problem' }));
  const matches = selected.length ? selected : problemMatches;
  const modern = reviewedProblems(corpus).length > 0 || corpus.records.some(record => Object.hasOwn(record, 'problemAnalysis'));
  const boundedLimit = Math.max(1, Math.min(corpus.records.length, limit ?? (modern || matches.length ? 100 : 15)));
  if (matches.length) return requesterLeads(corpus, idea, matches, boundedLimit, now);
  return keywordLeads(corpus, { ...idea, sourceIds: idea.sourceIds || [] }, boundedLimit, now, modern);
}

export function initialState() { return { idea: null, leads: [], leadSearch: null, shortlists: [], drafts: {}, profiles: {}, messages: [], threadId: null, pinned: [], selectedModel: null }; }
const referencedSources = (state, records) => new Set([...state.pinned, ...shortlistSourceIds(state.shortlists), ...(state.idea?.sourceIds || []), ...state.leads.flatMap(l => l.sourceIds), ...state.messages.flatMap(m => [...(m.sourceIds || []), ...citedSourceIds(m.text, records)])]);
export class AtlasStore {
  constructor(directory = resolve(ROOT, '.atlas')) { this.directory = directory; this.state = initialState(); this.corpus = { topics: TOPICS, records: [], status: [] }; this.queue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    const candidates = [];
    for (const file of [resolve(ROOT, 'data/seed.json'), resolve(this.directory, 'corpus.json')]) {
      try {
        const candidate = JSON.parse(await readFile(file, 'utf8'));
        candidates.push(candidate);
        const freshness = Date.parse(candidate.fetchedAt), current = Date.parse(this.corpus.fetchedAt);
        if (!this.corpus.fetchedAt || freshness > current || freshness === current && Date.parse(candidate.analysis?.generatedAt || candidate.fetchedAt) >= Date.parse(this.corpus.analysis?.generatedAt || this.corpus.fetchedAt)) this.corpus = candidate;
      } catch { /* Seed is optional until first ingestion. */ }
    }
    try { this.state = { ...initialState(), ...JSON.parse(await readFile(resolve(this.directory, 'state.json'), 'utf8')) }; } catch { /* Fresh local workspace. */ }
    const references = referencedSources(this.state, candidates.flatMap(c => c.records));
    const known = new Set(this.corpus.records.map(r => r.id));
    for (const candidate of candidates) for (const record of candidate.records) {
      if (references.has(record.id) && !known.has(record.id)) { this.corpus.records.push(record); known.add(record.id); }
    }
    return this;
  }
  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const path = resolve(this.directory, 'state.json');
      await writeFile(`${path}.tmp`, snapshot); await rename(`${path}.tmp`, path);
    });
    return this.queue;
  }
  async setCorpus(corpus) {
    if (!corpus.records.length) throw new Error('No records returned. Existing atlas was kept.');
    const references = referencedSources(this.state, this.corpus.records);
    const incomingIds = new Set(corpus.records.map(r => r.id));
    corpus.records.push(...this.corpus.records.filter(r => references.has(r.id) && !incomingIds.has(r.id)));
    this.corpus = corpus;
    await this.persistCorpus();
    await this.save();
  }
  async persistCorpus() {
    const path = resolve(this.directory, 'corpus.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.corpus, null, 2)); await rename(temporary, path);
  }
  source(id) { return this.corpus.records.find(r => r.id === id); }
  async saveProblem(input) {
    this.state.shortlists = updateShortlists(this.state.shortlists, input, this.corpus);
    // Seed data may change outside a running server. Keep saved evidence on disk too.
    if (input.saved) await this.persistCorpus();
    await this.save(); return this.state.shortlists;
  }
  async setIdea(input) {
    const title = String(input.title || '').trim().slice(0, 160);
    if (!title) throw new Error('Give your idea a name.');
    const attachedSourceIds = [...new Set(Array.isArray(input.sourceIds) ? input.sourceIds : [])].filter(id => this.source(id));
    const sourceIds = attachedSourceIds.slice(0, 30);
    const problemIds = selectedProblemIds(this.corpus, { sourceIds: attachedSourceIds, problemIds: input.problemIds });
    this.state.idea = { id: this.state.idea?.id || randomUUID(), title, description: String(input.description || '').trim().slice(0, 3000), sourceIds, problemIds, topicId: TOPICS.some(t => t.id === input.topicId) ? input.topicId : this.source(sourceIds[0])?.topicId || null, revision: (this.state.idea?.revision || 0) + 1, updatedAt: new Date().toISOString() };
    this.state.leads = [];
    this.state.leadSearch = null;
    this.state.drafts = {};
    await this.save(); return this.state.idea;
  }
  async findLeads({ embed = embedTexts } = {}) {
    if (!this.state.idea) throw new Error('Create an idea first.');
    const idea = this.state.idea, corpus = this.corpus;
    const selected = selectedProblemIds(corpus, idea);
    const modern = reviewedProblems(corpus).length > 0 || corpus.records.some(record => Object.hasOwn(record, 'problemAnalysis'));
    let problemMatches = [], error = null;
    if (!selected.length && reviewedProblems(corpus).length) {
      try { problemMatches = await matchIdeaProblems(corpus, idea, this.directory, { embed }); }
      catch (failure) { error = failure.message; }
    }
    if (this.state.idea?.revision !== idea.revision || this.corpus !== corpus) throw new Error('The idea or atlas changed. Find leads again.');
    const matches = selected.length ? selected.map(problemId => ({ problemId, matchKind: 'selected-problem' })) : problemMatches;
    const all = rankLeads(corpus, idea, matches.length ? corpus.records.length : modern ? 100 : 15, { problemMatches });
    this.state.leads = all.slice(0, 100);
    this.state.leadSearch = { method: selected.length ? 'selected-problem' : problemMatches.length ? 'semantic-problem' : modern ? 'keyword-request' : 'keyword-evidence', problemIds: matches.map(match => match.problemId), ...(selected.length ? {} : { threshold: .58 }), totalMatches: all.length, displayedCount: this.state.leads.length, status: error ? 'embedding-unavailable' : matches.length ? 'matched' : modern ? 'no-problem-match' : 'legacy', ...(error ? { error } : {}) };
    await this.save(); return this.state.leads;
  }
  async researchLead(id) {
    const lead = this.state.leads.find(l => l.id === id);
    if (!lead) throw new Error('Lead is not in the current idea.');
    const result = { name: lead.name, profileUrl: lead.profileUrl, fetchedAt: new Date().toISOString(), email: null, company: null, bio: null, website: null, status: 'ok', sourceChecks: [] };
    try {
      if (lead.source === 'github') {
        const profile = await publicFetch(`https://api.github.com/users/${encodeURIComponent(lead.name)}`);
        Object.assign(result, { displayName: profile.name, bio: profileText(profile.bio), company: profileText(profile.company), website: /^https?:\/\//.test(profile.blog) ? profile.blog : null, email: profile.email || null });
      } else if (lead.source === 'hn') {
        const profile = await publicFetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(lead.name)}.json`);
        result.bio = plainText(profile?.about || '');
        const email = result.bio.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0];
        result.email = email || null;
      } else result.status = 'link-only';
    } catch (error) { result.status = error.message; }
    for (const sourceId of lead.sourceIds.slice(0, 2)) {
      const source = this.source(sourceId);
      try {
        if (!source.apiUrl && source.source !== 'hn') { result.sourceChecks.push({ sourceId, status: 'unverified' }); continue; }
        const response = await publicFetch(source.apiUrl || `https://hacker-news.firebaseio.com/v0/item/${source.id.slice(3)}.json`);
        const fresh = source.source === 'stackexchange' ? response.items?.[0] : response;
        source.status = !fresh || fresh.deleted || fresh.dead ? 'deleted' : fresh.closed_date ? 'closed' : fresh.state || 'public';
        if (source.parentApiUrl && source.status !== 'deleted') {
          const parent = await publicFetch(source.parentApiUrl);
          if (parent.state === 'closed') source.status = 'closed';
        }
        if (source.status === 'deleted') source.text = 'This source was removed by its author.';
        source.fetchedAt = new Date().toISOString();
        result.sourceChecks.push({ sourceId, status: source.status, checkedAt: source.fetchedAt });
      } catch (error) { result.sourceChecks.push({ sourceId, status: 'unverified', error: error.message }); }
    }
    this.corpus = recountSignals(this.corpus);
    this.state.profiles[id] = result; await this.persistCorpus(); await this.save(); return result;
  }
  async saveDraft(input) {
    const lead = this.state.leads.find(l => l.id === input.leadId);
    if (!lead || lead.ideaRevision !== this.state.idea?.revision) throw new Error('Refresh leads for the current idea first.');
    if (!['dm', 'email'].includes(input.channel)) throw new Error('Unknown draft channel');
    const draft = { leadId: lead.id, channel: input.channel, subject: String(input.subject || '').slice(0, 250), body: String(input.body || '').slice(0, 6000), recipient: String(input.recipient || '').slice(0, 250), ideaRevision: this.state.idea.revision, updatedAt: new Date().toISOString() };
    this.state.drafts[`${lead.id}:${draft.channel}`] = draft;
    await this.save(); return draft;
  }
  publicState() { const { threadId, agentToolVersion, ...state } = this.state; return { ...state, profiles: Object.fromEntries(Object.entries(state.profiles).map(([id, profile]) => [id, publicProfile(profile)])), corpus: browserCorpus(this.corpus) }; }
}
