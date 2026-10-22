import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AtlasStore, dedupe, plainText, rankLeads, ROOT, searchRecords, TOPICS, matchesCollection } from '../server/data.mjs';
import { localOnly } from '../server/security.mjs';
import { AtlasAgent, CODEX_MODEL } from '../server/agent.mjs';

const record = (id, author, text, topicId = 'agents', status = 'open') => ({ id, author, authorId: `github:${author}`, source: 'github', text, title: text, topicId, status, url: `https://github.com/example/repo/issues/${id}`, profileUrl: `https://github.com/${author}`, date: '2026-10-22T12:00:00Z', fetchedAt: '2026-10-22T12:00:00Z' });
const corpus = { topics: TOPICS, records: [record('1', 'alex', 'Agent memory loses tool results'), record('2', 'alex', 'Agent memory checkpoints fail'), record('3', 'sam', 'Agent memory leaks between sessions'), record('4', 'jo', 'Payment invoice reconciliation', 'billing'), record('5', 'gone', 'Agent memory is broken', 'agents', 'deleted')] };

test('deduplicates source IDs without collapsing independent posts by one author', () => {
  assert.equal(dedupe([...corpus.records, { ...corpus.records[0], text: 'Updated report' }]).length, 5);
  assert.equal(dedupe([...corpus.records, { ...corpus.records[0], text: 'Updated report' }])[0].text, 'Updated report');
});
test('lead matching keeps provenance, merges one author and excludes removed sources', () => {
  const leads = rankLeads(corpus, { title: 'Agent memory', description: 'checkpoint reliability', sourceIds: ['1'], revision: 7, topicId: 'agents' });
  assert.equal(leads[0].id, 'github:alex');
  assert.deepEqual(new Set(leads[0].sourceIds), new Set(['1', '2']));
  assert.equal(leads[0].ideaRevision, 7);
  assert.ok(!leads.some(l => ['github:gone', 'github:jo'].includes(l.id)));
  assert.ok(leads.every(l => !('email' in l) && !('company' in l)));
  assert.equal(searchRecords(corpus, 'paleontology').length, 0);
});
test('explicit promotion is labeled and ranked below a comparable problem report', () => {
  const records = [record('builder', 'builder', 'Agent memory: I am the founder of our platform. Agent memory checkpoints.'), record('user', 'user', 'Agent memory checkpoints lose tool results')];
  const leads = rankLeads({ topics: TOPICS, records }, { title: 'Agent memory', description: 'checkpoints', sourceIds: [], revision: 1 });
  assert.equal(leads[0].id, 'github:user');
  assert.equal(leads.find(l => l.id === 'github:builder').kind, 'Shares a tool');
});
test('editing an idea clears stale leads and drafts, and persists the new revision', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-test-'));
  try {
    const store = await new AtlasStore(directory).load(); store.corpus = corpus;
    await store.setIdea({ title: 'Agent memory', description: 'checkpoints', sourceIds: ['1', 'invented', '1'] });
    assert.deepEqual(store.state.idea.sourceIds, ['1']);
    await store.findLeads();
    await store.saveDraft({ leadId: 'github:alex', channel: 'dm', body: 'How do you handle this now?' });
    assert.ok(store.state.drafts['github:alex:dm']);
    await store.setIdea({ title: 'Payment reconciliation', description: 'Invoices for finance teams', sourceIds: ['4'], topicId: 'billing' });
    assert.equal(store.state.idea.revision, 2);
    assert.deepEqual(store.state.leads, []); assert.deepEqual(store.state.drafts, {});
    await assert.rejects(store.saveDraft({ leadId: 'github:alex', channel: 'dm', body: 'stale' }));
    const leads = await store.findLeads(); assert.equal(leads[0].id, 'github:jo');
    const restored = await new AtlasStore(directory).load(); assert.equal(restored.state.idea.title, 'Payment reconciliation');
    assert.equal(restored.state.leads[0].ideaRevision, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('public HTML is text, never executable markup', () => {
  assert.equal(plainText('<p>A &amp; B</p><script>alert(1)</script>'), 'A & B');
  assert.ok(!plainText('<img src=x onerror=alert(1)>Hello').includes('<img'));
  assert.doesNotThrow(() => plainText('&#99999999;'));
});
test('collection ingestion rejects broad search fallback matches', () => {
  const agents = TOPICS.find(t => t.id === 'agents');
  assert.equal(matchesCollection(agents, 'PHP memory leaks in a long-running service'), false);
  assert.equal(matchesCollection(agents, 'Coding agents lose memory between sessions'), true);
  const testing = TOPICS.find(t => t.id === 'testing');
  assert.equal(matchesCollection(testing, 'Flaky test failures in CI'), true);
  assert.equal(matchesCollection(testing, 'The tests are running'), false);
});
test('a refresh keeps source records already attached to an idea', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-refresh-test-'));
  try {
    const store = await new AtlasStore(directory).load(); store.corpus = corpus;
    await store.setIdea({ title: 'Agent memory', description: '', sourceIds: ['1'] });
    await store.setCorpus({ topics: TOPICS, records: [corpus.records[3]], fetchedAt: '2026-10-22T18:00:00Z' });
    assert.equal(store.source('1').url, corpus.records[0].url);
    assert.equal(store.state.idea.sourceIds[0], '1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('local agent endpoints reject remote origins and DNS rebinding hosts', () => {
  const run = headers => { let allowed = false, status; localOnly(3000)({ headers }, { status(code) { status = code; return this; }, json() {} }, () => { allowed = true; }); return { allowed, status }; };
  assert.equal(run({ host: 'localhost:3000', origin: 'http://localhost:3000' }).allowed, true);
  assert.equal(run({ host: 'localhost:3000', origin: 'https://evil.example' }).status, 403);
  assert.equal(run({ host: 'evil.example:3000' }).status, 403);
  assert.equal(run({ host: 'localhost:3000', origin: 'http://localhost:4000' }).status, 403);
  assert.equal(run({ host: 'localhost:3000', origin: 'null' }).status, 403);
});
test('shipped corpus has original source URLs, timestamps and no repeated source IDs', async () => {
  const seed = JSON.parse(await readFile(resolve(ROOT, 'data/seed.json'), 'utf8'));
  assert.ok(seed.records.length >= 200); assert.equal(seed.records.length, dedupe(seed.records).length);
  for (const r of seed.records) {
    const hosts = { github: ['github.com'], hn: ['news.ycombinator.com'], reddit: ['www.reddit.com', 'reddit.com'], stackexchange: ['softwarerecs.stackexchange.com'], x: ['x.com', 'twitter.com'], linkedin: ['www.linkedin.com', 'linkedin.com'] };
    assert.ok(hosts[r.source]?.includes(new URL(r.url).hostname));
    assert.ok(Number.isFinite(Date.parse(r.date))); assert.ok(Number.isFinite(Date.parse(r.fetchedAt)));
    assert.ok(r.text && r.author && r.profileUrl && TOPICS.some(t => t.id === r.topicId));
    if (r.request) {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      assert.ok([r.title, r.text].some(value => normalize(value).includes(normalize(r.request.quote))), `Nonliteral request quote: ${r.id}`);
    }
  }
});
test('Codex turns use GPT 6 Luna even if an older preference or request specifies another model', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-model-test-'));
  try {
    const store = await new AtlasStore(directory).load(); store.state.selectedModel = 'older-preference';
    const agent = new AtlasAgent(store, () => {}), requests = [];
    agent.connect = async () => {}; agent.models = [{ model: CODEX_MODEL }];
    agent.request = async (method, params) => { requests.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'test-thread' } } : { turn: { id: 'test-turn' } }; };
    await agent.chat('Find evidence', {}, 'other-model');
    assert.equal(requests.find(r => r.method === 'thread/start').params.model, 'gpt-6-luna');
    assert.equal(requests.find(r => r.method === 'turn/start').params.model, 'gpt-6-luna');
    assert.equal(store.state.selectedModel, 'gpt-6-luna');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('tool upgrades preserve the visible conversation and pass its context to the new runtime', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-migration-'));
  try {
    const store = await new AtlasStore(directory).load();
    store.state.threadId = 'legacy-thread';
    store.state.messages = [{ id: 'prior', role: 'user', text: 'Investigate webhook reliability.' }];
    const agent = new AtlasAgent(store, () => {}), requests = [];
    agent.connect = async () => {};
    agent.request = async (method, params) => { requests.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'upgraded-thread' } } : { turn: { id: 'test-turn' } }; };
    await agent.chat('Read the current request groups', {}, CODEX_MODEL);
    assert.equal(store.state.messages[0].id, 'prior');
    assert.ok(!requests.some(r => r.method === 'thread/resume'));
    assert.ok(requests.find(r => r.method === 'thread/start').params.dynamicTools.some(t => t.name === 'atlas_signals'));
    assert.match(requests.find(r => r.method === 'turn/start').params.input[0].text, /Investigate webhook reliability/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vague discovery cannot replace the chosen idea or clear its leads and drafts', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-discovery-'));
  try {
    const store = await new AtlasStore(directory).load(); store.corpus = corpus;
    await store.setIdea({ title: 'My existing idea', sourceIds: ['1'] });
    store.state.leads = [{ id: 'saved-lead', sourceIds: ['1'] }]; store.state.drafts = { saved: { body: 'Keep this draft' } };
    const original = JSON.stringify({ idea: store.state.idea, leads: store.state.leads, drafts: store.state.drafts });
    const agent = new AtlasAgent(store, () => {}); agent.connect = async () => {};
    agent.request = async method => method === 'thread/start' ? { thread: { id: 'discovery' } } : { turn: { id: 'turn' } };
    await agent.chat('What should I build?');
    for (const tool of ['atlas_save_idea', 'atlas_find_leads', 'atlas_save_draft']) await assert.rejects(agent.executeTool(tool, { title: 'Unchosen idea' }), /discovery request/);
    assert.equal(JSON.stringify({ idea: store.state.idea, leads: store.state.leads, drafts: store.state.drafts }), original);
    agent.active = null;
    await agent.chat('Save that idea and find leads');
    assert.equal(agent.active.exploratory, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
