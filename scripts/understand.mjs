import { parseArgs } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AtlasStore, ROOT } from '../server/data.mjs';
import { analyzeCorpus } from '../server/signals.mjs';
import { createReasoner, openIntelligenceCache, understandRequests } from '../server/intelligence.mjs';
const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, 'max-new': { type: 'string', default: '2000' }, 'batch-size': { type: 'string', default: '20' }, 'cache-only': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '3' } } });
const maxNewRecords = Number(values['max-new']), concurrency = Number(values.concurrency), batchSize = Number(values['batch-size']);
if (!Number.isInteger(maxNewRecords) || maxNewRecords < 0 || maxNewRecords > 15000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('Use --max-new 0..15000 and --concurrency 1..6');
if (!Number.isInteger(batchSize) || batchSize < 10 || batchSize > 50) throw new Error('Use --batch-size 10..50');
const store = await new AtlasStore(process.env.ATLAS_DIRECTORY || undefined).load();
const inputPath = resolve(values.input || resolve(ROOT, 'data/seed.json'));
const inputBytes = await readFile(inputPath);
const inputHash = createHash('sha256').update(inputBytes).digest('hex');
if (values.input) { store.corpus = JSON.parse(inputBytes); if (!Array.isArray(store.corpus.records)) throw new Error('Input must contain a records array.'); }
const reasoner = await createReasoner(store.directory);
const progress = value => { if (value.phase !== 'model') console.log(JSON.stringify(value)); };
try {
  if (values['cache-only']) {
    const result = await understandRequests(store.corpus, await openIntelligenceCache(store.directory), reasoner, progress, { maxNewRecords, concurrency, batchSize });
    console.log(JSON.stringify({ analyzed: result.analyzed, requests: result.requests.length, pending: result.pending, rejected: result.rejected.length }));
  } else {
    const corpus = await analyzeCorpus(store.corpus, store.directory, progress, { maxNewRecords, concurrency, batchSize, reasoner });
    const latestHash = createHash('sha256').update(await readFile(inputPath)).digest('hex');
    if (latestHash !== inputHash) throw new Error('The source snapshot changed during analysis. Cached results are preserved. Run understand again.');
    const path = resolve(values.output || resolve(ROOT, 'data/seed.json')); await writeFile(`${path}.tmp`, JSON.stringify(corpus, null, 2)); await rename(`${path}.tmp`, path);
    console.log(JSON.stringify({ records: corpus.records.length, analysis: corpus.analysis, top: corpus.signals.slice(0, 12).map(s => ({ label: s.label, requests: s.requesterCount, platforms: s.platforms })) }, null, 2));
  }
} finally { reasoner.close(); }
