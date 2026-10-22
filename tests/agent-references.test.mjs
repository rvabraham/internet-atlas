import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlasAgent, CODEX_MODEL } from '../server/agent.mjs';
import { citedSourceIds, citedSourceOccurrences } from '../shared/citations.mjs';

const sources = [
  { id: 'hn:123', url: 'https://news.ycombinator.com/item?id=123' },
  { id: 'gh:456', url: 'https://github.com/acme/tools/issues/456' },
];
function fixture() {
  const events = [], state = { threadId: 'chat-thread', messages: [] };
  const store = { directory: '/private/tmp/atlas-agent-test', state, corpus: { records: sources, signals: [{ id: 'signal:retry', sourceIds: sources.map(s => s.id) }] }, source: id => sources.find(s => s.id === id), save: async () => {} };
  const agent = new AtlasAgent(store, (type, data) => events.push({ type, data }));
  agent.active = { id: 'answer', parts: {} };
  return { agent, store, events };
}

test('every complete citation occurrence pulses once, including repeated references', async () => {
  const { agent, events } = fixture();
  const delta = text => agent.receive({ method: 'item/agentMessage/delta', params: { threadId: 'chat-thread', itemId: 'text', delta: text } });
  await delta('Evidence [one](https://news.ycombinator.com/item?id=12');
  assert.equal(events.filter(e => e.type === 'agent-reference').length, 0);
  await delta('3)');
  await delta(' says this.');
  await delta(' Again [one](https://news.ycombinator.com/item?id=123).');
  assert.deepEqual(events.filter(e => e.type === 'agent-reference').map(e => e.data.nodeIds), [['hn:123'], ['hn:123']]);
  await agent.receive({ method: 'item/completed', params: { threadId: 'chat-thread', item: { id: 'text', type: 'agentMessage', text: Object.values(agent.active.parts).join('') } } });
  assert.equal(events.filter(e => e.type === 'agent-reference').length, 2);
});

test('reading nodes pulses them but final references contain only final cited sources', async () => {
  const { agent, store, events } = fixture();
  await agent.executeTool('atlas_get_source', { sourceId: 'gh:456' });
  await agent.executeTool('atlas_get_signal', { signalId: 'signal:retry' });
  assert.deepEqual(events.filter(e => e.type === 'agent-reference').map(e => e.data.nodeIds), [['gh:456'], ['signal:retry', 'hn:123', 'gh:456']]);
  agent.active.parts.answer = `The request is here: [original](${sources[0].url}).`;
  await agent.finish(null);
  assert.deepEqual(store.state.messages[0].sourceIds, ['hn:123']);
  assert.deepEqual(events.find(e => e.type === 'agent-done').data.sourceIds, ['hn:123']);
});

test('structured analysis uses isolated GPT 6 Luna threads without changing the chat', async () => {
  const { agent, store, events } = fixture();
  const calls = [], original = JSON.stringify(store.state);
  agent.connect = async () => {};
  agent.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'analysis-thread' } };
    if (method === 'turn/start') {
      await agent.receive({ method: 'item/completed', params: { threadId: 'analysis-thread', item: { id: 'json', type: 'agentMessage', text: '{"request":true}' } } });
      await agent.receive({ method: 'turn/completed', params: { threadId: 'analysis-thread', turn: { status: 'completed' } } });
      return { turn: { id: 'structured-turn' } };
    }
    return {};
  };
  const schema = { type: 'object', properties: { request: { type: 'boolean' } }, required: ['request'], additionalProperties: false };
  assert.deepEqual(await agent.completeJSON('Analyze supplied evidence', schema), { request: true });
  assert.equal(JSON.stringify(store.state), original);
  assert.equal(agent.active.id, 'answer');
  assert.equal(events.length, 0);
  const start = calls.find(c => c.method === 'thread/start').params;
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(start.model, CODEX_MODEL); assert.equal(turn.model, CODEX_MODEL);
  assert.equal(start.ephemeral, true); assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(turn.outputSchema, schema);
  assert.equal(agent.jsonJobs.size, 0);
});

test('intermediate citations pulse but only the final answer is saved and highlighted', async () => {
  const { agent, store, events } = fixture();
  for (const [id, phase, text] of [['progress', 'commentary', `Checking [earlier](${sources[1].url}).`], ['final', 'final_answer', `Use [this request](${sources[0].url}).`]]) {
    await agent.receive({ method: 'item/completed', params: { threadId: 'chat-thread', item: { type: 'agentMessage', id, phase, text } } });
  }
  await agent.finish(null);
  assert.equal(store.state.messages[0].text, `Use [this request](${sources[0].url}).`);
  assert.deepEqual(store.state.messages[0].sourceIds, ['hn:123']);
  assert.deepEqual(events.filter(event => event.type === 'agent-reference').map(event => event.data.nodeIds), [['gh:456'], ['hn:123']]);
});

test('unknown URLs never become graph references and final IDs deduplicate repeated sources', () => {
  const text = `[a](${sources[0].url}) [a again](${sources[0].url}) https://unknown.example/source`;
  assert.deepEqual(citedSourceOccurrences(text, sources), ['hn:123', 'hn:123']);
  assert.deepEqual(citedSourceIds(text, sources), ['hn:123']);
});

test('stopping a chat aborts its analysis job and interrupts both model turns', async () => {
  const { agent, store } = fixture(), calls = [];
  agent.active.controller = new AbortController(); agent.active.turnId = 'outer-turn';
  agent.connect = async () => {};
  agent.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'analysis-thread' } };
    if (method === 'turn/start') { queueMicrotask(() => agent.stop()); return { turn: { id: 'inner-turn' } }; }
    return {};
  };
  await assert.rejects(agent.completeJSON('Analyze', {}, { signal: agent.active.controller.signal }), /Stopped/);
  assert.equal(agent.jsonJobs.size, 0);
  const interrupted = calls.filter(call => call.method === 'turn/interrupt');
  assert.ok(interrupted.some(call => call.params.threadId === store.state.threadId && call.params.turnId === 'outer-turn'));
  assert.ok(interrupted.some(call => call.params.threadId === 'analysis-thread' && call.params.turnId === 'inner-turn'));
});
