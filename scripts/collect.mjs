import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../server/data.mjs';
import { collectProblemRequests, PROBLEM_FAMILIES } from '../server/sources.mjs';

const { values } = parseArgs({ options: {
  query: { type: 'string', multiple: true }, pages: { type: 'string', default: '2' },
  providers: { type: 'string', default: 'hn,reddit,stackexchange,github' },
  output: { type: 'string', default: resolve(ROOT, 'data/seed.json') },
  'since-days': { type: 'string', default: '365' },
} });
const output = resolve(values.output), pages = Number(values.pages), sinceDays = Number(values['since-days']);
if (!Number.isInteger(pages) || pages < 1 || pages > 3) throw new Error('--pages must be 1, 2, or 3.');
if (!Number.isInteger(sinceDays) || sinceDays < 30 || sinceDays > 3650) throw new Error('--since-days must be between 30 and 3650.');
let corpus;
try { corpus = JSON.parse(await readFile(output, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; corpus = { records: [], topics: [] }; }
if (!Array.isArray(corpus.records)) throw new Error('Input seed must contain a records array.');
const before = corpus.records.length, rateState = {}, runs = [];
const queries = values.query?.length ? values.query : PROBLEM_FAMILIES.map(family => family.name);
for (const query of queries) {
  console.log(JSON.stringify({ phase: 'problem', query }));
  try {
    corpus = await collectProblemRequests(query, corpus, progress => {
      if (progress.phase === 'collecting') console.log(JSON.stringify({ source: progress.source, query: progress.query, page: progress.page, status: progress.status, requests: progress.count, error: progress.error }));
    }, { pages, sinceDays, providers: values.providers.split(',').map(value => value.trim()).filter(Boolean), rateState });
    runs.push(corpus.collection);
  } catch (error) { runs.push({ query, error: error.message }); console.error(JSON.stringify({ query, error: error.message })); }
}
if (!runs.some(run => !run.error)) throw new Error('No collection succeeded. Seed was kept.');
// Collection never fabricates clusters. The next analyze pass rebuilds them from these records.
delete corpus.signals; delete corpus.analysis;
corpus.records = corpus.records.map(({ signalId, ...record }) => record);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify(corpus, null, 2)); await rename(temporary, output);
const sources = corpus.records.reduce((counts, record) => ({ ...counts, [record.source]: (counts[record.source] || 0) + 1 }), {});
console.log(JSON.stringify({ phase: 'complete', added: corpus.records.length - before, total: corpus.records.length, sources, runs: runs.map(run => ({ query: run.query, added: run.added, sources: run.sources, errors: run.errors || run.error })) }, null, 2));
console.log('Seed written. Run npm run analyze before restarting the app.');
