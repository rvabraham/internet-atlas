import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { AtlasStore, ROOT, ingest, searchRecords } from './data.mjs';
import { AtlasAgent } from './agent.mjs';
import { localOnly } from './security.mjs';
import { analyzeCorpus } from './signals.mjs';
import { sourceHealth } from './health.mjs';
import { createStateBroadcaster } from '../shared/state-transport.mjs';
import { createNodeSearch } from './semantic-search.mjs';
import { nodeSearchResponse, pendingNodeSearch } from './node-search-api.mjs';

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 3000);
const store = await new AtlasStore(process.env.ATLAS_DIRECTORY || undefined).load();
const nodeSearch = createNodeSearch({ getCorpus: () => store.corpus, directory: store.directory });
store.nodeSearch = nodeSearch;
const clients = new Set();
const stateBroadcast = createStateBroadcaster(store.corpus);
const emit = (event, payload) => {
  const outgoing = event === 'state' ? stateBroadcast(payload, store.corpus) : payload;
  const frame = `event: ${event}\ndata: ${JSON.stringify(outgoing)}\n\n`;
  for (const client of clients) client.write(frame);
};
const agent = new AtlasAgent(store, emit);
let refreshing = false;

app.use('/api', localOnly(port), express.json({ limit: '80kb' }));
app.get('/api/state', (_req, res) => res.json(store.publicState()));
app.get('/api/health', (_req, res) => res.json(sourceHealth(store.corpus)));
app.post('/api/shortlists', async (req, res) => { const shortlists = await store.saveProblem(req.body); emit('state', store.publicState()); res.json({ shortlists }); });
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
  res.write(': connected\n\n'); clients.add(res);
  // Reconnections must recover a corpus change missed while the client was offline.
  res.write(`event: state\ndata: ${JSON.stringify(store.publicState())}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
});
app.get('/api/search', (req, res) => res.json(searchRecords(store.corpus, String(req.query.q || ''), 40, req.query.topic || undefined)));
app.get('/api/nodes/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 500);
  const options = { topicId: String(req.query.topic || ''), sourceFilters: String(req.query.sources || '').split(',').filter(Boolean), limit: Math.max(1, Math.min(80, Number(req.query.limit) || 60)) };
  const info = nodeSearch.info();
  if (['idle', 'indexing'].includes(info.state)) {
    nodeSearch.prewarm().catch(error => console.error(`Node index: ${error.message}`));
    return res.json(nodeSearchResponse(pendingNodeSearch(store.corpus, query, options), info, query));
  }
  const found = await nodeSearch.search(query, options);
  res.json(nodeSearchResponse(found, nodeSearch.info(), query));
});
app.get('/api/nodes/:id/related', async (req, res) => {
  const options = { topicId: String(req.query.topic || ''), sourceFilters: String(req.query.sources || '').split(',').filter(Boolean), limit: Math.max(1, Math.min(40, Number(req.query.limit) || 12)) };
  const found = await nodeSearch.neighbors(req.params.id, options);
  res.json(nodeSearchResponse(found, nodeSearch.info()));
});
app.post('/api/idea', async (req, res) => { const idea = await store.setIdea(req.body); emit('state', store.publicState()); res.json(idea); });
app.post('/api/leads', async (_req, res) => { const leads = await store.findLeads(); emit('state', store.publicState()); res.json(leads); });
app.post('/api/leads/research', async (req, res) => { const profile = await store.researchLead(req.body.leadId); emit('state', store.publicState()); res.json(profile); });
app.post('/api/draft', async (req, res) => { const draft = await store.saveDraft(req.body); emit('state', store.publicState()); res.json(draft); });
app.post('/api/pins', async (req, res) => { store.state.pinned = [...new Set(req.body.ids || [])].filter(id => store.source(id)).slice(0, 30); await store.save(); emit('state', store.publicState()); res.json({ ok: true }); });
app.post('/api/refresh', async (_req, res) => {
  if (refreshing || store.collecting || agent.active) return res.status(409).json({ error: 'A refresh is already running.' });
  refreshing = true; store.collecting = true; res.json({ ok: true }); emit('refresh', { status: 'running' });
  try { const progress = detail => emit('refresh', { status: 'running', ...detail }); const corpus = await ingest(progress, store.corpus); await store.setCorpus(await analyzeCorpus(corpus, store.directory, progress)); emit('state', store.publicState()); emit('refresh', { status: 'complete' }); }
  catch (error) { emit('refresh', { status: 'error', error: error.message }); }
  finally { refreshing = false; store.collecting = false; }
});
app.get('/api/agent/status', (_req, res) => res.json(agent.info()));
app.post('/api/agent/connect', async (_req, res) => res.json(await agent.connect()));
app.post('/api/agent/chat', async (req, res) => res.json(await agent.chat(req.body.text, req.body.context, req.body.model)));
app.post('/api/agent/stop', async (_req, res) => { await agent.stop(); res.json({ ok: true }); });
app.get('/api/export', (_req, res) => {
  const { idea, leads, drafts } = store.state;
  const lines = ['# ' + (idea?.title || 'Internet Atlas'), '', idea?.description || '', '', '## Evidence', ...(idea?.sourceIds || []).map(id => { const s = store.source(id); return s ? `- [${s.title}](${s.url}) by ${s.author}, ${s.date.slice(0, 10)}` : ''; }), '', '## People', ...leads.map(l => `- [${l.name}](${l.profileUrl})\n${l.sourceIds.map(id => `  - ${store.source(id)?.url}`).join('\n')}`), '', '## Drafts', ...Object.values(drafts).map(d => `### ${d.leadId}, ${d.channel}\n${d.subject}\n\n${d.body}\n`), '', 'Public evidence suggests interview candidates. It does not establish buying intent. No outreach was sent.'];
  res.set('Content-Disposition', 'attachment; filename="internet-atlas.md"').type('text/markdown').send(lines.join('\n'));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((error, _req, res, _next) => { console.error(error.message); res.status(error.status || 400).json({ error: error.message || 'Request failed.' }); });
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve(ROOT, 'dist'))); app.get('/{*path}', (_req, res) => res.sendFile(resolve(ROOT, 'dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root: ROOT, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' }); app.use(vite.middlewares);
}
server.listen(port, '127.0.0.1', () => {
  console.log(`Internet Atlas: http://localhost:${port} (${store.corpus.records.length} public records)`);
  nodeSearch.prewarm().then(info => console.log(`Node index: ${info.state}, ${info.indexedCount}/${info.nodeCount}`)).catch(error => console.error(`Node index: ${error.message}`));
});
const shutdown = () => { agent.close(); for (const client of clients) client.end(); server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
