import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProblemRequests, problemQueryPlan, parseRedditFeed, authoredPlainText, hnRecord, createPublicCollectorClient } from '../server/sources.mjs';

const hit = (id, text = 'I need a webhook tool that retries failed deliveries without sending duplicate events.') => ({ objectID: String(id), author: `requester${id}`, story_title: 'Reliable webhook automation', comment_text: text, story_id: '42', created_at: new Date(Date.now() - 86400000).toISOString() });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('query plans expand actual workflow terms with bounded paging', () => {
  const plan = problemQueryPlan('webhook reliability', { pages: 20 });
  assert.equal(plan.family, 'webhooks'); assert.equal(plan.pages, 3);
  assert.ok(plan.terms.includes('webhook replay')); assert.ok(plan.repos.includes('n8n-io/n8n'));
  assert.equal(problemQueryPlan('audit workarounds').family, 'custom');
  assert.throws(() => problemQueryPlan('a'), /specific problem/);
});

test('collection accepts explicit asks, rejects announcements, and canonically preserves source IDs', async () => {
  const existing = { id: 'saved-source', source: 'hn', url: 'https://news.ycombinator.com/item?id=1', author: 'requester1', authorId: 'hn:requester1', text: hit(1).comment_text, title: 'Reliable webhook automation', date: hit(1).created_at };
  const corpus = await collectProblemRequests('webhook reliability', { records: [existing] }, () => {}, {
    providers: ['hn'], pages: 1, sleep: async () => {},
    fetch: async () => response({ hits: [hit(1), hit(2), hit(3, 'I built a webhook tool. Try my app for automation and retries.')], nbPages: 1 }),
  });
  assert.equal(corpus.records.length, 2); assert.equal(corpus.collection.added, 1);
  assert.equal(corpus.records.find(record => record.url.endsWith('id=1')).id, 'saved-source');
  const added = corpus.records.find(record => record.id === 'hn:2');
  assert.equal(added.request.type, 'feature_request'); assert.equal(added.collection.problem, 'webhook reliability');
  assert.match(added.collection.endpoint, /^https:\/\/hn.algolia.com/);
  assert.ok(corpus.collection.duplicates > 0); assert.ok(corpus.collection.rejected > 0);
});

test('HTTP 403 stops a provider for the run and keeps the previous atlas', async () => {
  let calls = 0; const previous = { records: [{ id: 'keep', text: 'keep' }] };
  await assert.rejects(collectProblemRequests('webhook reliability', previous, () => {}, { providers: ['hn'], fetch: async () => { calls++; return response({}, 403); } }), /Existing atlas was kept/);
  assert.equal(calls, 1); assert.equal(previous.records[0].id, 'keep');
});

test('429 honors Retry-After and retries only once', async () => {
  let calls = 0; const sleeps = [];
  const corpus = await collectProblemRequests('webhook reliability', { records: [] }, () => {}, {
    providers: ['hn'], pages: 1, sleep: async delay => { sleeps.push(delay); },
    fetch: async () => { calls++; return calls === 1 ? response({}, 429, { 'retry-after': '1' }) : response({ hits: [hit(2)], nbPages: 1 }); },
  });
  assert.equal(corpus.collection.added, 1); assert.ok(sleeps.includes(1000));
});

test('Stack Exchange long backoff does not hammer the API or erase records', async () => {
  let calls = 0; const errors = [];
  const corpus = await collectProblemRequests('webhook reliability', { records: [] }, progress => { if (progress.error) errors.push(progress.error); }, {
    providers: ['stackexchange'], pages: 3, sleep: async () => {},
    fetch: async () => { calls++; return response({ items: [], has_more: true, backoff: 120, quota_remaining: 99 }); },
  });
  assert.equal(calls, 1); assert.equal(corpus.records.length, 0); assert.ok(errors.some(error => /backoff until/.test(error)));
});

test('Reddit RSS retains original public author, text, and timestamp and rejects entities', () => {
  const xml = '<feed><entry><id>t3_example</id><title>Looking for a webhook tool</title><author><name>/u/person</name></author><link href="https://www.reddit.com/r/n8n/comments/example/request/"/><updated>2026-01-02T03:04:05Z</updated><content>&lt;p&gt;I need a webhook app with retry and replay support.&lt;/p&gt;</content></entry></feed>';
  const records = parseRedditFeed(xml); assert.equal(records.length, 1);
  assert.equal(records[0].author, 'person'); assert.match(records[0].text, /I need a webhook app/);
  assert.equal(records[0].date, '2026-01-02T03:04:05Z');
  assert.throws(() => parseRedditFeed('<!DOCTYPE feed [<!ENTITY a "bad">]><feed/>'), /Unsupported/);
});

test('GitHub collection counts authored feature requests and comments, never reactions or +1 replies', async () => {
  const parent = { id: 400, title: '[Feature] Fine grained permissions', body: 'I need an app to assign permissions to specific projects in our workspace.', user: { login: 'owner', html_url: 'https://github.com/owner', type: 'User' }, html_url: 'https://github.com/supabase/auth/issues/1', url: 'https://api.github.com/repos/supabase/auth/issues/1', created_at: new Date(Date.now() - 86400000).toISOString(), state: 'open', comments: 3, labels: [{ name: 'enhancement' }], reactions: { total_count: 99 } };
  const comment = { id: 401, body: 'I need an API to limit permissions to a single project for contractors.', user: { login: 'requester', html_url: 'https://github.com/requester', type: 'User' }, html_url: 'https://github.com/supabase/auth/issues/1#issuecomment-401', url: 'https://api.github.com/repos/supabase/auth/issues/comments/401', created_at: parent.created_at };
  const corpus = await collectProblemRequests('internal permissions', { records: [] }, () => {}, {
    providers: ['github'], pages: 1, sleep: async () => {},
    fetch: async url => url.includes('/search/issues?') ? response({ items: [parent] }) : response([comment, { ...comment, id: 402, body: '+1', html_url: 'https://github.com/supabase/auth/issues/1#issuecomment-402' }, { ...comment, id: 403, user: { ...comment.user, type: 'Bot' } }]),
  });
  assert.equal(corpus.records.length, 2); assert.equal(corpus.collection.added, 2);
  assert.equal(corpus.records.find(record => record.recordType === 'comment').threadUrl, parent.html_url);
  assert.equal(corpus.records.find(record => record.recordType === 'comment').author, 'requester');
});

test('a pre-aborted collection makes no provider requests and keeps its input unchanged', async () => {
  const controller = new AbortController(); controller.abort(new Error('Collection cancelled'));
  let calls = 0; const previous = { records: [{ id: 'keep', text: 'unchanged' }], feeds: [] };
  const before = JSON.stringify(previous);
  await assert.rejects(collectProblemRequests('webhook reliability', previous, () => {}, {
    signal: controller.signal, fetch: async () => { calls++; return response({ hits: [] }); },
  }), /Collection cancelled/);
  assert.equal(calls, 0); assert.equal(JSON.stringify(previous), before);
});

test('cancellation during provider pacing prevents the next fetch and all later providers', async () => {
  const controller = new AbortController(); let calls = 0, sleeps = 0;
  await assert.rejects(collectProblemRequests('webhook reliability', { records: [] }, () => {}, {
    signal: controller.signal, rateState: { hn: { nextAt: Date.now() + 1000, requests: 0 } },
    sleep: async () => { sleeps++; controller.abort(new Error('Cancelled while pacing')); },
    fetch: async () => { calls++; return response({ hits: [] }); },
  }), /Cancelled while pacing/);
  assert.equal(sleeps, 1); assert.equal(calls, 0);
});

test('an in-flight fetch receives a signal combining caller cancellation and the request timeout', async () => {
  const controller = new AbortController(); let calls = 0, combinedSignal;
  await assert.rejects(collectProblemRequests('webhook reliability', { records: [] }, () => {}, {
    signal: controller.signal,
    fetch: async (_url, options) => {
      calls++; combinedSignal = options.signal;
      assert.ok(combinedSignal instanceof AbortSignal);
      assert.notEqual(combinedSignal, controller.signal, 'the request also needs its own timeout signal');
      const result = new Promise((_resolve, reject) => combinedSignal.addEventListener('abort', () => reject(combinedSignal.reason), { once: true }));
      queueMicrotask(() => controller.abort(new Error('Cancelled in flight')));
      return result;
    },
  }), /Cancelled in flight/);
  assert.equal(calls, 1); assert.equal(combinedSignal.aborted, true);
});

test('cancellation during Retry-After pacing prevents the retry and following providers', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(collectProblemRequests('webhook reliability', { records: [] }, () => {}, {
    signal: controller.signal,
    fetch: async () => { calls++; return response({}, 429, { 'retry-after': '1' }); },
    sleep: async () => controller.abort(new Error('Cancelled during backoff')),
  }), /Cancelled during backoff/);
  assert.equal(calls, 1);
});

test('cancellation after response decoding is not swallowed as a provider error', async () => {
  const controller = new AbortController(); let calls = 0; const events = [];
  await assert.rejects(collectProblemRequests('webhook reliability', { records: [] }, event => events.push(event), {
    signal: controller.signal,
    fetch: async () => {
      calls++; return { ok: true, status: 200, headers: new Headers(), json: async () => { controller.abort(new Error('Cancelled while decoding')); return { hits: [hit(800)], nbPages: 1 }; } };
    },
  }), /Cancelled while decoding/);
  assert.equal(calls, 1); assert.equal(events.some(event => event.phase === 'collected'), false);
});

test('cancellation from final progress cannot return a seed result', async () => {
  const controller = new AbortController(); const previous = { records: [] };
  await assert.rejects(collectProblemRequests('webhook reliability', previous, event => {
    if (event.phase === 'collected') controller.abort(new Error('Cancelled before result'));
  }, {
    providers: ['hn'], pages: 1, signal: controller.signal, sleep: async () => {},
    fetch: async () => response({ hits: [hit(800)], nbPages: 1 }),
  }), /Cancelled before result/);
  assert.equal(previous.records.length, 0);
});


test('quoted asks and quoted +1 replies never become the current author request', () => {
  const html = '<blockquote>I need a ChatGPT app to search old conversations.<blockquote>Another quoted need.</blockquote>More quoted context.</blockquote><p>+1</p>';
  const record = hnRecord(hit(888, html));
  assert.ok(!record || !record.text.includes('I need a ChatGPT'));
  assert.equal(authoredPlainText('&amp;gt; I need an app to search PDF files.\n+1').includes('I need'), false);
  const own = authoredPlainText('<blockquote>I need calendar software.</blockquote><p>I need an API to synchronize free/busy availability.</p>');
  assert.ok(own.includes('I need an API')); assert.equal(own.includes('calendar software'), false);
});

test('public collector records every attempt and resumes 429 only after its backoff', async () => {
  let now = 1000, calls = 0;
  const client = createPublicCollectorClient({ now: () => now, sleep: async delay => { now += delay; }, intervals: { hn: 0, reddit: 1000 }, resumeAfterBackoff: true,
    fetch: async () => { calls++; return calls <= 2 ? response({}, 429, { 'retry-after': '2' }) : new Response('<feed/>', { status: 200 }); },
  });
  await assert.rejects(client.request('reddit', 'https://www.reddit.com/search.rss?q=software', 'xml'), /HTTP 429/);
  assert.equal(calls, 2); assert.ok(client.disabled('reddit'));
  now += 2000; assert.equal(client.disabled('reddit'), undefined);
  assert.deepEqual(await client.request('reddit', 'https://www.reddit.com/search.rss?q=software', 'xml'), []);
  assert.equal(client.attempts.length, 3); assert.equal(client.attempts[0].status, 429);
  assert.equal(client.attempts[0].retryAfterMs, 2000); assert.equal(client.attempts[2].ok, true);
  assert.equal(client.attempts[2].rawCount, 0, 'successful empty feeds are not errors');
});

test('title-only Ask HN requests retain their authors without inheriting a title into empty comments', () => {
  const title = 'Ask HN: Is there a tool to search all my local PDF files?';
  const post = hnRecord({ objectID: '991', author: 'pdf-user', title, story_text: '', _tags: ['story', 'ask_hn'], created_at: hit(1).created_at });
  assert.equal(post.recordType, 'post'); assert.equal(post.textScope, 'title-only'); assert.equal(post.text, title);
  assert.equal(hnRecord({ objectID: '992', author: 'commenter', story_title: title, comment_text: null, story_id: '991', _tags: ['comment'], created_at: hit(1).created_at }), null);
});
