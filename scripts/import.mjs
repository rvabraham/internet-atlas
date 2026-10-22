import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import { AtlasStore, ROOT } from '../server/data.mjs';
import { importDataset } from '../server/imports.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';
import { analyzeCorpus } from '../server/signals.mjs';
const options = Object.fromEntries(['file', 'source', 'name', 'dataset-url', 'license', 'text-column', 'author-column', 'date-column', 'url-column', 'title-column', 'profile-column'].map(name => [name, { type: 'string' }]));
const { values } = parseArgs({ options });
if (!values.file) throw new Error('Provide --file, --source, --name, --dataset-url and --license');
const store = await new AtlasStore().load();
const imported = await importDataset(resolve(values.file), { source: values.source, name: values.name, url: values['dataset-url'], license: values.license }, Object.fromEntries(['text', 'author', 'date', 'url', 'title', 'profile'].map(field => [field, values[`${field}-column`]])));
console.log(JSON.stringify(imported.report, null, 2));
if (!imported.records.length) throw new Error('No traceable public posts were accepted. Existing atlas kept.');
const byUrl = new Map(store.corpus.records.map(record => [canonicalSourceUrl(record.url), record]));
for (const record of imported.records) { const existing = byUrl.get(canonicalSourceUrl(record.url)); if (!existing || existing.origin === 'dataset') byUrl.set(canonicalSourceUrl(record.url), record); }
const corpus = await analyzeCorpus({ ...store.corpus, records: [...byUrl.values()], fetchedAt: new Date().toISOString() }, store.directory, progress => { if (progress.phase !== 'model') console.log(JSON.stringify(progress)); });
const path = resolve(ROOT, 'data/seed.json'); await writeFile(`${path}.tmp`, JSON.stringify(corpus, null, 2)); await rename(`${path}.tmp`, path);
console.log(`Imported ${imported.records.length} public posts. Restart the app to load the new snapshot.`);
