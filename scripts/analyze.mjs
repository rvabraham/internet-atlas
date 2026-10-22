import { AtlasStore, ROOT } from '../server/data.mjs';
import { analyzeCorpus } from '../server/signals.mjs';
import { resolve } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
const store = await new AtlasStore().load();
let last = '';
const result = await analyzeCorpus(store.corpus, store.directory, progress => { const key = `${progress.phase}:${progress.completed ?? progress.progress}`; if (key !== last) { last = key; console.log(JSON.stringify(progress)); } });
const path = resolve(ROOT, 'data/seed.json'); await writeFile(`${path}.tmp`, JSON.stringify(result, null, 2)); await rename(`${path}.tmp`, path);
console.log(JSON.stringify({ records: result.records.length, requests: result.analysis.requestCount, signals: result.signals.length, top: result.signals.slice(0, 8).map(s => ({ label: s.label, requests: s.requesterCount, tier: s.tier.label })) }, null, 2));
