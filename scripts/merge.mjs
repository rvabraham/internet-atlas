import { parseArgs } from 'node:util';
import { resolve, dirname, basename, extname } from 'node:path';
import { readFile, mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mergeNormalizedSnapshots } from '../server/merge.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  base: { type: 'string', default: resolve(ROOT, 'data/seed.json') },
  input: { type: 'string', multiple: true },
  output: { type: 'string', default: resolve(ROOT, '.atlas/merged-input.json') },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Merge normalized public-source snapshots into staging.\n\nnode scripts/merge.mjs --input .atlas/expansion-ready.json --input .atlas/datasets/reddit-combined.json --input .atlas/datasets/community-x.json\n\n--base defaults to data/seed.json. --output defaults to .atlas/merged-input.json.\nNo model calls, source requests, analysis or app-state writes.');
  process.exit(0);
}
if (!values.input?.length) throw new Error('Provide at least one --input normalized JSON snapshot. Use --help for an example.');

async function actualPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await actualPath(parent), basename(path));
  }
}
const base = resolve(values.base), inputs = values.input.map(path => resolve(path)), output = resolve(values.output);
const actualOutput = await actualPath(output);
if (extname(output).toLowerCase() !== '.json') throw new Error('--output must be a JSON staging file');
if (['seed.json', 'state.json', 'corpus.json'].includes(basename(output).toLowerCase()) || ['seed.json', 'state.json', 'corpus.json'].includes(basename(actualOutput).toLowerCase())) throw new Error('Refusing to overwrite seed, state or corpus. Choose a separate staging JSON output.');
for (const input of [base, ...inputs]) if (await actualPath(input) === actualOutput) throw new Error('The output must be separate from every base and input file');
const paths = [base, ...inputs];
const raw = await Promise.all(paths.map(path => readFile(path, 'utf8')));
const snapshots = raw.map((text, index) => {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${paths[index]}: invalid JSON (${error.message})`); }
});
const merged = mergeNormalizedSnapshots(snapshots[0], snapshots.slice(1), { baseLabel: base, inputLabels: inputs, inputHashes: raw.map(text => createHash('sha256').update(text).digest('hex')) });
await mkdir(dirname(output), { recursive: true });
const temporary = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
try { await writeFile(temporary, JSON.stringify(merged, null, 2), { flag: 'wx' }); await rename(temporary, output); }
finally { await rm(temporary, { force: true }); }
console.log(JSON.stringify({ ...merged.merge, output }, null, 2));
