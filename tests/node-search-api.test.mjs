import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingNodeSearch, nodeSearchResponse } from '../server/node-search-api.mjs';
import { AtlasAgent, TOOL_SPECS } from '../server/agent.mjs';

test('cold search serves exact matches with indexing status and excludes private sources', () => {
  const source = (id, source = 'hn', status = 'public') => ({ id, source, status, topicId: 'agents', author: 'alex', authorId: `${source}:alex`, title: 'Find old conversations', text: 'I need software to search old conversations.', date: new Date().toISOString() });
  const corpus = { records: [source('one'), source('private', 'hn', 'private'), source('reddit', 'reddit')], topics: [] };
  const found = pendingNodeSearch(corpus, 'old conversations', { sourceFilters: ['hn'], topicId: 'agents' });
  assert.deepEqual(found.results.map(row => row.id), ['one']);
  assert.equal(found.method, 'keyword');
  const response = nodeSearchResponse(found, { indexedCount: 0, nodeCount: 2 }, 'old conversations');
  assert.equal(response.status, 'indexing'); assert.equal(response.indexed, 0); assert.equal(response.total, 2);
});

test('the agent uses semantic node search and related nodes without changing demand or exposing raw HTML', async () => {
  const records = [{ id: 'hn:1', title: 'Search conversations', text: 'An original public request.', author: 'alex', originalHtml: '<p>Original</p>' }];
  const signals = [{ id: 'problem:history', label: 'Retrieve past conversations', sourceIds: ['hn:1'], requesterCount: 1 }];
  const corpus = { records, signals };
  const before = JSON.stringify(corpus), calls = [];
  const store = { corpus, source: id => records.find(row => row.id === id), nodeSearch: {
    search: async (query, options) => { calls.push({ query, options }); return { method: 'hybrid', state: 'ready', results: [{ id: 'problem:history', kind: 'problem', score: .8 }, { id: 'hn:1', kind: 'source', score: .7 }] }; },
    neighbors: async () => ({ method: 'semantic', state: 'ready', results: [{ id: 'hn:1', kind: 'source', score: .7 }] }),
  } };
  const events = [], agent = new AtlasAgent(store, (event, payload) => events.push({ event, payload }));
  const found = await agent.executeTool('atlas_search', { query: 'recover knowledge from previous chats', topicId: '' });
  assert.equal(found.method, 'hybrid'); assert.equal(found.results.length, 2);
  assert.equal(found.results[1].originalHtml, undefined); assert.equal(found.results[1].excerpt, records[0].text);
  assert.equal(calls[0].options.limit, 14);
  const related = await agent.executeTool('atlas_related_nodes', { nodeId: 'problem:history' });
  assert.equal(related.contributesToDemand, false); assert.equal(related.sameProblemVerified, false);
  assert.equal(JSON.stringify(corpus), before);
  assert.ok(!events.some(row => row.event === 'state'));
  assert.ok(TOOL_SPECS.some(tool => tool.name === 'atlas_related_nodes'));
});
