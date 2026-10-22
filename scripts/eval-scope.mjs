import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReasoner, REASONING_MODEL } from '../server/intelligence.mjs';
import { buildCompactExtractionPrompt, COMPACT_EXTRACTION_SCHEMA, normalizeCompactExtractions } from '../server/compact.mjs';
import { validateExtractions, PROBLEM_CONTRACT_VERSION } from '../server/problems.mjs';

// Explicit, subscription-consuming evaluation. npm test never calls a cloud model.
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/scope-cases.json', import.meta.url), 'utf8'));
const directory = resolve('.atlas/qa-scope-eval'); await mkdir(directory, { recursive: true });
const reasoner = await createReasoner(directory);
try {
  const records = cases.map(row => row.record);
  const raw = await reasoner.complete(buildCompactExtractionPrompt(records), COMPACT_EXTRACTION_SCHEMA);
  const checked = validateExtractions(normalizeCompactExtractions(raw), records);
  const rows = cases.map(row => {
    const extraction = checked.accepted.find(item => item.sourceId === row.record.id);
    return { sourceId: row.record.id, url: row.record.url, case: row.name, expectedRequest: row.expectedRequest, classification: extraction?.classification || 'invalid', pass: Boolean(extraction) && (extraction.classification === 'request') === row.expectedRequest };
  });
  const receipt = { model: REASONING_MODEL, contract: PROBLEM_CONTRACT_VERSION, at: new Date().toISOString(), passed: rows.filter(row => row.pass).length, total: rows.length, rows, rejected: checked.rejected };
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  if (rows.some(row => !row.pass)) process.exitCode = 1;
} finally { reasoner.close(); }
