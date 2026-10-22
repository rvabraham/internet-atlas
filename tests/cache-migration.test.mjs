import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseNarrowedNonrequests } from '../server/cache-migration.mjs';
import { sourceContentHash } from '../server/problems.mjs';

test('scope narrowing reuses only exact-content exclusions, never old positives or unsupported quotes', () => {
  const records = ['excluded', 'positive', 'edited', 'invented'].map(id => ({ id, source: 'hn', title: 'A software discussion', text: 'I built an application for searching old conversations.', author: id, authorId: id, date: '2026-10-20', url: `https://news.ycombinator.com/item?id=${id}` }));
  const rows = records.map(record => ({ sourceId: record.id, classification: record.id === 'positive' ? 'request' : 'promotion', audience: '', workflow: '', problem: '', desiredOutcome: '', evidenceQuote: record.text, confidence: .9, proposedProblemKey: null, requesterRole: 'unknown', contentHash: sourceContentHash(record), model: 'gpt-6-luna', contractVersion: 'problem-understanding-v1', analyzedAt: '2026-10-21' }));
  records[2].text += ' The source was edited.'; rows[3].evidenceQuote = 'Invented evidence.';
  const cache = { data: { extractions: Object.fromEntries(rows.map((row, i) => [`old-${i}`, row])) } };
  assert.equal(reuseNarrowedNonrequests(records, cache), 1);
  const added = Object.entries(cache.data.extractions).filter(([key]) => !key.startsWith('old-')).map(([, row]) => row);
  assert.equal(added[0].sourceId, 'excluded'); assert.equal(added[0].reusedFromContract, 'problem-understanding-v1');
  assert.equal(reuseNarrowedNonrequests(records, cache), 0, 'repeated migration is idempotent');
});
