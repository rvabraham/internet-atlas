import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlasAgent } from '../server/agent.mjs';

async function prepared() {
  const records = Array.from({ length: 10 }, (_, i) => ({ id: `hn:${100 + i}`, source: 'hn', author: `person${i}`, authorId: `hn:person${i}`, title: 'Search local PDF documents', text: `I need a tool to search my local PDF collection offline in folder ${i}.`, date: new Date(Date.now() - 86400000).toISOString(), status: 'public', url: `https://news.ycombinator.com/item?id=${100 + i}` }));
  for (const source of records) source.problemAnalysis = { classification: 'request', confidence: .95, requesterRole: 'user', workflow: 'Search local PDF documents', problem: 'Finding a passage requires opening individual files', desiredOutcome: 'Search all local PDF documents offline', evidenceQuote: source.text };
  const signal = { id: 'signal:pdf', reviewed: true, confidence: .95, label: 'Search local PDF documents', workflow: 'Search local PDF documents', problem: 'Finding a passage requires opening individual files', desiredOutcome: 'Search all local PDF documents offline', sourceIds: records.map(source => source.id), audit: { status: 'verified' } };
  const state = { messages: [], idea: { title: 'Existing idea' }, leads: [{ id: 'saved-lead' }], drafts: { existing: 'Keep this' } };
  const store = { directory: '/private/tmp/atlas-fake-agent', state, corpus: { records, signals: [signal] }, source: id => store.corpus.records.find(source => source.id === id), save: async () => {} };
  const agent = new AtlasAgent(store, () => {});
  agent.active = { id: 'answer', parts: {}, exploratory: true };
  await agent.executeTool('atlas_opportunities', { query: '' });
  await agent.executeTool('atlas_get_opportunity', { problemId: signal.id, cursor: '' });
  for (const source of records.slice(0, 3)) await agent.executeTool('atlas_get_source', { sourceId: source.id });
  await agent.executeTool('atlas_recommend_opportunity', { problemId: signal.id, title: 'Private PDF search', description: 'Find passages across local PDF document collections.' });
  agent.active.parts.final = `Build local PDF search, supported by 10 recent requesters. [Original request](${records[0].url}).`;
  return { agent, store, state, records, signal };
}

test('withdrawn sources or changed evidence invalidate a prepared cohort before final counts or highlights are saved', async () => {
  for (const change of [
    ({ records }) => { records.at(-1).status = 'removed'; },
    ({ records }) => { records.at(-1).opted_out = true; },
    ({ records }) => { records.at(-1).date = '2020-01-01T00:00:00Z'; },
    ({ records }) => { records.at(-1).text = 'This source now asks for calendar synchronization instead.'; },
    ({ signal }) => { signal.desiredOutcome = 'Synchronize events across all local calendars'; },
  ]) {
    const fixture = await prepared(), { agent, state } = fixture;
    const before = JSON.stringify({ idea: state.idea, leads: state.leads, drafts: state.drafts });
    change(fixture); await agent.finish(null);
    const message = state.messages[0];
    assert.match(message.error, /Evidence changed during research/); assert.equal(message.text, message.error); assert.ok(!message.text.includes('10 recent requesters'));
    assert.equal(message.opportunity, undefined); assert.deepEqual(message.sourceIds, []);
    assert.equal(JSON.stringify({ idea: state.idea, leads: state.leads, drafts: state.drafts }), before);
  }
});

test('unrelated corpus changes and successful source-check timestamps do not invalidate the same supporting cohort', async () => {
  const { agent, state, store, records } = await prepared();
  const other = { ...records[0], id: 'hn:999', author: 'other', authorId: 'hn:other', url: 'https://news.ycombinator.com/item?id=999', text: 'I need software to reconcile invoice payments across stores.' };
  other.problemAnalysis = { ...records[0].problemAnalysis, evidenceQuote: other.text, workflow: 'Reconcile invoice payments', desiredOutcome: 'Match payments to invoices' };
  store.corpus = { ...store.corpus, records: [...records, other], fetchedAt: new Date().toISOString() };
  records[0].fetchedAt = new Date().toISOString();
  await agent.finish(null);
  assert.equal(state.messages[0].error, null); assert.equal(state.messages[0].opportunity.requesterCount, 10); assert.equal(state.messages[0].sourceIds.length, 10); assert.ok(!state.messages[0].sourceIds.includes(other.id));
});

test('ordinary final citations also exclude removed and opted-out sources', async () => {
  const { agent, state, records } = await prepared();
  delete agent.active.recommendation; delete agent.active.recommendationFingerprint;
  records[1].status = 'deleted'; records[2].optedOut = true;
  agent.active.parts.final = records.slice(0, 3).map(record => `[Original](${record.url})`).join(' ');
  await agent.finish(null);
  assert.deepEqual(state.messages[0].sourceIds, [records[0].id]); assert.equal(state.messages[0].opportunity, undefined);
});

test('structured analysis forwards explicit reasoning effort and defaults to low without real model calls', async () => {
  const agent = new AtlasAgent({ directory: '/private/tmp/atlas-fake-agent' }, () => {}), starts = [];
  agent.connect = async () => {};
  agent.request = async (method, args) => {
    if (method === 'thread/start') return { thread: { id: 'fake-job' } };
    if (method === 'turn/start') {
      starts.push(args);
      queueMicrotask(() => agent.jsonJobs.get('fake-job').resolve({ ok: true }));
      return { turn: { id: 'fake-turn' } };
    }
    return {};
  };
  const schema = { type: 'object' };
  assert.deepEqual(await agent.completeJSON('Analyze supplied evidence.', schema, { effort: 'medium' }), { ok: true });
  assert.deepEqual(await agent.completeJSON('Analyze supplied evidence.', schema), { ok: true });
  assert.deepEqual(starts.map(start => start.effort), ['medium', 'low']); assert.ok(starts.every(start => start.model === 'gpt-6-luna'));
});
