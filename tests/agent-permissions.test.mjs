import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlasAgent, actionPermissions } from '../server/agent.mjs';

function setup() {
  const state = { messages: [], idea: { title: 'Existing idea', revision: 1 }, leads: [{ id: 'existing-lead' }], drafts: { existing: 'Keep this draft' } };
  const store = {
    directory: '/private/tmp/atlas-fake-agent', state, corpus: { records: [], signals: [], topics: [] }, save: async () => {}, publicState: () => state,
    async setIdea(input) { state.idea = input; state.leads = []; state.drafts = {}; return input; },
    async findLeads() { state.leads = [{ id: 'new-lead' }]; return state.leads; },
    async saveDraft(input) { state.drafts[input.leadId] = input; return input; },
  };
  const agent = new AtlasAgent(store, () => {});
  agent.connect = async () => {};
  agent.request = async method => method === 'thread/start' ? { thread: { id: 'fake-thread' } } : { turn: { id: 'fake-turn' } };
  return { agent, state };
}
const chosen = state => JSON.stringify({ idea: state.idea, leads: state.leads, drafts: state.drafts });

test('incidental save wording in business discovery cannot mutate the chosen idea, leads or drafts', async () => {
  for (const prompt of ['What should I build to save people time?', 'Which business saves teams money?', 'What should I build that saves people time?', 'Find an idea for a product that can save time.', 'What should I build?', 'I want to save people time with a new business idea.', 'Save our team time with an idea.', 'I build products that save people time. What should I try next?']) {
    const { agent, state } = setup(), before = chosen(state);
    await agent.chat(prompt);
    assert.equal(agent.active.exploratory, true, prompt);
    for (const name of ['atlas_save_idea', 'atlas_find_leads', 'atlas_save_draft']) await assert.rejects(agent.executeTool(name, { title: 'Unchosen replacement' }), /discovery request/, `${prompt}: ${name}`);
    assert.equal(chosen(state), before, prompt);
  }
});

test('an actual idea choice permits the saved-idea workflow', async () => {
  for (const prompt of ['I choose the document search idea.', "let's build this", 'Save that idea and find leads', 'Please save the offline PDF search idea.', 'Use this idea.', 'I pick local PDF search.']) {
    const { agent, state } = setup();
    await agent.chat(prompt);
    assert.equal(agent.active.exploratory, false, prompt); assert.equal(agent.active.permissions.atlas_save_idea, true, prompt);
    await agent.executeTool('atlas_save_idea', { title: 'Chosen PDF search' });
    assert.equal(state.idea.title, 'Chosen PDF search');
  }
});

test('requesting leads or a draft does not authorize replacing the saved idea', async () => {
  for (const prompt of ['Find my first customers', 'Please find leads', 'Draft an email to the selected lead']) {
    const { agent, state } = setup(), before = chosen(state);
    await agent.chat(prompt);
    assert.equal(agent.active.exploratory, false, prompt);
    await assert.rejects(agent.executeTool('atlas_save_idea', { title: 'Unchosen replacement' }), /does not authorize/);
    assert.equal(chosen(state), before, prompt);
  }
  const { agent, state } = setup(); await agent.chat('Find my first customer');
  await agent.executeTool('atlas_find_leads'); assert.equal(state.leads[0].id, 'new-lead'); assert.equal(state.idea.title, 'Existing idea'); assert.equal(state.drafts.existing, 'Keep this draft');
  assert.deepEqual(actionPermissions('Draft emails'), { atlas_save_idea: false, atlas_find_leads: false, atlas_save_draft: true });
});
