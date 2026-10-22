import { ingest, ROOT } from '../server/data.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let previous = { records: [] };
try { previous = JSON.parse(await readFile(resolve(ROOT, 'data/seed.json'), 'utf8')); } catch { /* First ingestion. */ }
const corpus = await ingest(({topic}) => console.log(`Fetching ${topic}`), previous);
if (!corpus.records.length) throw new Error('No public records returned');
await mkdir(resolve(ROOT, 'data'), { recursive: true });
await writeFile(resolve(ROOT, 'data/seed.json'), JSON.stringify(corpus, null, 2));
console.log(JSON.stringify({ records: corpus.records.length, fetchedAt: corpus.fetchedAt, status: corpus.status }, null, 2));
