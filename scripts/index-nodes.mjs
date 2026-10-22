import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AtlasStore } from '../server/data.mjs';
import { createNodeSearch } from '../server/semantic-search.mjs';

const { values } = parseArgs({ options: { input: { type: 'string' }, query: { type: 'string' } } });
const store = await new AtlasStore(process.env.ATLAS_DIRECTORY || undefined).load();
if (values.input) store.corpus = JSON.parse(await readFile(resolve(values.input), 'utf8'));
let last = -1;
const index = createNodeSearch({ getCorpus: () => store.corpus, directory: store.directory, onProgress: progress => {
  const step = Math.floor(20 * (progress.completed || 0) / Math.max(1, progress.total || 1));
  if (step !== last) { last = step; console.log(JSON.stringify(progress)); }
} });
const started = performance.now();
await index.prewarm();
console.log(JSON.stringify({ ...index.info(), elapsedMs: Math.round(performance.now() - started) }));
if (values.query) {
  const start = performance.now();
  const result = await index.search(values.query, { limit: 12 });
  console.log(JSON.stringify({ ...result, elapsedMs: Math.round(performance.now() - start) }, null, 2));
}
