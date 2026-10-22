import { parseArgs } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AtlasStore, ROOT } from '../server/data.mjs';
import { analyzeCorpus } from '../server/signals.mjs';
import { createReasoner, openIntelligenceCache, understandRequests } from '../server/intelligence.mjs';
const { values } = parseArgs({ options: { 'max-new': { type: 'string', default: '2000' }, 'cache-only': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '3' } } });
const maxNewRecords = Number(values['max-new']), concurrency = Number(values.concurrency);
if (!Number.isInteger(maxNewRecords) || maxNewRecords < 0 || maxNewRecords > 5000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Use --max-new 0..5000 and --concurrency 1..3');
const store = await new AtlasStore().load();
const reasoner = await createReasoner(store.directory);
const progress = value => { if (value.phase !== 'model') console.log(JSON.stringify(value)); };
try {
  if (values['cache-only']) {
    const result = await understandRequests(store.corpus, await openIntelligenceCache(store.directory), reasoner, progress, { maxNewRecords, concurrency });
    console.log(JSON.stringify({ analyzed: result.analyzed, requests: result.requests.length, pending: result.pending, rejected: result.rejected.length }));
  } else {
    const corpus = await analyzeCorpus(store.corpus, store.directory, progress, { maxNewRecords, concurrency, reasoner });
    const latest = JSON.parse(await readFile(resolve(ROOT, 'data/seed.json'), 'utf8'));
    if (latest.fetchedAt !== store.corpus.fetchedAt) throw new Error('The source snapshot changed during analysis. Cached results are preserved. Run understand again.');
    const path = resolve(ROOT, 'data/seed.json'); await writeFile(`${path}.tmp`, JSON.stringify(corpus, null, 2)); await rename(`${path}.tmp`, path);
    console.log(JSON.stringify({ records: corpus.records.length, analysis: corpus.analysis, top: corpus.signals.slice(0, 12).map(s => ({ label: s.label, requests: s.requesterCount, platforms: s.platforms })) }, null, 2));
  }
} finally { reasoner.close(); }
