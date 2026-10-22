import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../server/data.mjs';
import { expandPublicRequests } from '../server/expansion.mjs';

const { values } = parseArgs({ options: {
  input: { type: 'string', default: resolve(ROOT, 'data/seed.json') },
  output: { type: 'string', default: resolve(ROOT, '.atlas/expansion-staging.json') },
  families: { type: 'string' }, providers: { type: 'string', default: 'hn,reddit,stackexchange' },
  from: { type: 'string', default: new Date(Date.now() - 365 * 86400000).toISOString() },
  'max-new': { type: 'string', default: '10000' }, 'hn-requests': { type: 'string', default: '500' },
  'reddit-requests': { type: 'string', default: '20' }, 'stack-pages': { type: 'string', default: '40' },
  'no-broad': { type: 'boolean', default: false },
} });
const output = resolve(values.output);
if (output === resolve(ROOT, 'data/seed.json') || output === resolve(ROOT, '.atlas/state.json') || output === resolve(ROOT, '.atlas/corpus.json')) throw new Error('Expansion writes a staging file only. Choose a different --output.');
const previous = JSON.parse(await readFile(resolve(values.input), 'utf8'));
if (!Array.isArray(previous.records)) throw new Error('Input must contain public records.');
if (previous.expansion?.status === 'running') { previous.expansion.status = 'interrupted'; previous.expansion.completedAt = new Date().toISOString(); }
if (previous.expansion) previous.expansions = (previous.expansions || []).map(run => run.id === previous.expansion.id ? previous.expansion : run);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('Expansion cancelled')));
process.on('SIGTERM', () => controller.abort(new Error('Expansion cancelled')));
const checkpoint = async corpus => {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(corpus)); await rename(temporary, output);
};
const result = await expandPublicRequests(previous, progress => console.log(JSON.stringify(progress)), {
  signal: controller.signal, onCheckpoint: checkpoint,
  families: values.families?.split(',').map(value => value.trim()).filter(Boolean),
  providers: values.providers.split(',').map(value => value.trim()).filter(Boolean),
  from: values.from, maxNewRecords: Number(values['max-new']), hnRequests: Number(values['hn-requests']),
  redditRequests: Number(values['reddit-requests']), stackPages: Number(values['stack-pages']), broad: !values['no-broad'],
});
await checkpoint(result);
console.log(JSON.stringify({ phase: 'complete', output, totalRecords: result.records.length, run: { ...result.expansion, attempts: result.expansion.attempts.length, health: undefined, queries: undefined, families: result.expansion.families } }, null, 2));
console.log('Staging written. Seed and conversation state were not changed.');
