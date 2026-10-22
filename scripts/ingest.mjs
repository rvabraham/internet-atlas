import { ingest, ROOT } from '../server/data.mjs';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeCorpus } from '../server/signals.mjs';
let previous = { records: [] };
try { previous = JSON.parse(await readFile(resolve(ROOT, 'data/seed.json'), 'utf8')); } catch { /* First ingestion. */ }
const collected = await ingest(({topic}) => console.log(`Fetching ${topic}`), previous);
const corpus = await analyzeCorpus(collected, resolve(ROOT, '.atlas'), progress => { if (progress.phase !== 'model') console.log(JSON.stringify(progress)); });
if (!corpus.records.length) throw new Error('No public records returned');
await mkdir(resolve(ROOT, 'data'), { recursive: true });
const path = resolve(ROOT, 'data/seed.json'); await writeFile(`${path}.tmp`, JSON.stringify(corpus, null, 2)); await rename(`${path}.tmp`, path);
console.log(JSON.stringify({ records: corpus.records.length, fetchedAt: corpus.fetchedAt, status: corpus.status }, null, 2));
