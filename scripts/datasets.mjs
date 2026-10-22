import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectArchiveRequests, ARCHIVE_LANES, communityArchiveRecord, COMMUNITY_ARCHIVE } from '../server/datasets.mjs';
import { ROOT } from '../server/data.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: resolve(ROOT, '.atlas/datasets') },
  provider: { type: 'string', default: 'arctic-shift' },
  input: { type: 'string' }, manifest: { type: 'string' }, eligibility: { type: 'string' },
  'max-records': { type: 'string', default: '12000' },
  'max-requests': { type: 'string', default: '250' },
  'since-days': { type: 'string', default: '365' },
  subreddit: { type: 'string', multiple: true },
} });
const maxRecords = Number(values['max-records']), maxRequests = Number(values['max-requests']), sinceDays = Number(values['since-days']);
if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 15000) throw new Error('--max-records must be between 1 and 15000');
if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 400) throw new Error('--max-requests must be between 1 and 400');
if (!Number.isInteger(sinceDays) || sinceDays < 30 || sinceDays > 3650) throw new Error('--since-days must be between 30 and 3650');
if (values.provider === 'community-archive') {
  if (!values.input || !values.manifest || !values.eligibility) throw new Error('Community Archive import requires --input JSONL, --manifest, and --eligibility latest.json from the same current export.');
  const manifest = JSON.parse(await readFile(resolve(values.manifest), 'utf8'));
  const latest = JSON.parse(await readFile(resolve(values.eligibility), 'utf8'));
  if (manifest.export_id !== latest.export_id || !Array.isArray(latest.eligible_account_ids)) throw new Error('Export and eligibility snapshots do not match.');
  const eligibleAccountIds = new Set(latest.eligible_account_ids);
  const rows = (await readFile(resolve(values.input), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const normalized = rows.map(row => communityArchiveRecord(row, manifest, { eligibleAccountIds, minimumDate: Date.now() - sinceDays * 86400000 })).filter(Boolean);
  const records = [...new Map(normalized.map(record => [record.id, record])).values()].slice(0, maxRecords);
  const fetchedAt = new Date().toISOString();
  const report = { scannedCandidates: rows.length, accepted: records.length, authors: new Set(records.map(record => record.authorId)).size, heuristicRequests: records.filter(record => record.request).length, exportId: manifest.export_id, consentSnapshotAt: manifest.consent.snapshot_at, checksum: manifest.files?.tweets?.sha256, totalExportRows: manifest.files?.tweets?.rows, eligibleAccounts: manifest.consent.eligible_accounts };
  const result = { fetchedAt, dataset: COMMUNITY_ARCHIVE, records, feeds: [{ source: 'x', adapter: 'community-archive', status: records.length ? 'ok' : 'error', count: records.length, fetchedAt, error: null, query: 'Recent original software asks from consenting archive members', retryAt: null }], report };
  const output = values.output.endsWith('.json') ? resolve(values.output) : resolve(values.output, 'community-x.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(`${output}.tmp`, JSON.stringify(result, null, 2)); await rename(`${output}.tmp`, output);
  console.log(JSON.stringify({ phase: 'complete', ...report, output }, null, 2));
} else if (values.provider === 'arctic-shift') {
  const lanes = values.subreddit?.length ? ARCHIVE_LANES.filter(lane => values.subreddit.includes(lane.subreddit)) : ARCHIVE_LANES;
  if (!lanes.length) throw new Error('No matching configured subreddit lanes');
  const result = await collectArchiveRequests(resolve(values.output), progress => console.log(JSON.stringify(progress)), { maxRecords, maxRequests, sinceDays, lanes });
  console.log(JSON.stringify({ phase: 'complete', ...result.report, output: resolve(values.output, 'reddit-archive.json') }, null, 2));
} else throw new Error('Use --provider arctic-shift or community-archive.');
