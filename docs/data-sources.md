# Data sources and imports

Access notes are current as of October 22, 2026.

Internet Atlas counts distinct public authors making explicit requests. The count uses a rolling 365-day window, excludes future-dated posts, and changes tier at 10, 20 and 50 requesters. Reactions, generic mentions and brief endorsements do not become request counts. Similarity groups and lead relevance are inferred. They do not establish purchase intent or market size.

## Connected sources

| Source | Access used by this app | Limits and interpretation |
| --- | --- | --- |
| [HN Algolia](https://hn.algolia.com/api) and [HN API](https://github.com/HackerNews/API) | Public search, original discussions and public source/profile checks. No key required. | Queries sample public discussion. Results are not complete internet coverage or evidence of buying authority. |
| [GitHub REST API](https://docs.github.com/en/rest) | Public open issues and selected authored comments. An optional `GITHUB_TOKEN` raises the ordinary unauthenticated limit of 60 requests/hour. | Search has a separate limit. Closed issues, promotions and bots are excluded from request counts. Multiple requests by one platform author count once per signal. |
| [Reddit RSS](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026) | Public subreddit search feeds currently work without keys. Failures are reported as unavailable coverage. | Reddit's October 8, 2026 changelog says RSS ends November 13, 2026 and new API access requests close October 31, 2026. This is temporary access, not a durable or guaranteed free Reddit integration. |
| [Project Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md) | Public Reddit archive API, without credentials or paid calls. Original author, permalink, date and archive provenance are retained. | Archive search is sampled and can be stale. Broad queries returned HTTP 422 query timeouts during collection. The collector narrows date windows, pauses after timeouts and stops on access denial or rate limiting. No archive content license is asserted. |
| [Community Archive](https://www.community-archive.org/docs) | The supported daily public X Parquet export, with an export manifest, consenting account list, original status IDs and checksums. No X credentials or paid calls. | This is an opt-in community sample. The October 22 export contains 939 eligible accounts, of which 595 supplied the retained software-ask candidates. It is not a general X search index. The current filtered API requires a personal Community Archive key. |
| [Mashu Data Reddit Comment Trees Sample](https://huggingface.co/datasets/mashu-data/reddit-comments-sample/tree/6ded3d3ed1f0342708f86b781c933b9f961d97a3) | LocalLLaMA posts and comments from the June through August 2026 snapshot. Original authors, dates and comment permalinks are retained. | CC BY-NC 4.0 for noncommercial research, to the extent the publisher holds rights. Original Reddit author rights remain. This sample has incomplete and unrepresentative community coverage. Finance and skincare portions are excluded. |
| [Software Recommendations on Stack Exchange](https://api.stackexchange.com/docs) | The adapter reads public questions without a key and preserves attribution/license information. | Availability and quotas are controlled by the provider. Failed reads remain unavailable. A recommendation question is evidence of a stated need, not budget or purchase intent. |

The snapshot retains each post's original URL, public author, original date and retrieval time. A public profile is a reply path, not permission to contact someone. Cross-platform identities are not inferred. Atlas has no outreach send endpoint.

## Getting Reddit and X access

For Reddit, [submit the Data API access form](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164) with this app's purpose and data needs, then follow the credentials flow if approved. New requests close October 31, 2026. [Register the app on the Developer Platform](https://developers.reddit.com/) and review the migration path. [Commercial use requires Reddit's permission and a contract](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data). Do not assume that registering produces unrestricted search access. The current collection paths use public RSS and attributable archive/dataset records, without an authenticated Reddit adapter.

For X, use the [Developer Console](https://console.x.com/) to set up developer access and an app, generate its bearer token, and configure a spending limit before enabling paid reads. The [current pricing page](https://docs.x.com/x-api/getting-started/pricing) lists $0.005 per public post read and $0.010 per user read, so 1,000 post reads alone would cost $5. Rates and endpoint access can change. Do not paste tokens into chat. A live X adapter still needs to be connected once access is available; the current importer uses no token and makes no paid calls.

## Archive collection and provenance

The archive tools stage candidates in the ignored `.atlas/datasets/` directory. Candidate counts describe retrieved posts that still need quote-backed model classification and problem review. They are not validated demand counts and do not set group membership.

The completed collection receipts are:

| Staged corpus | Candidates | Public accounts | Existing heuristic matches |
| --- | ---: | ---: | ---: |
| Arctic Shift successful pages | 370 | 351 | 144 |
| Community Archive X export | 4,128 | 595 | 1,687 |
| LocalLLaMA research sample | 512 | 439 | 163 |

Accounts and canonical URLs can overlap across Reddit corpora. These columns must not be added to obtain a unique requester total. All retained candidates are within the rolling 365-day window. The intelligence pass can reject promotions, general discussion, advice and unsupported asks.

Run a bounded Reddit archive collection from the project directory:

```sh
node scripts/datasets.mjs \
  --provider arctic-shift \
  --max-records 12000 \
  --max-requests 250 \
  --since-days 365 \
  --output .atlas/datasets
```

This command stages `reddit-archive.json` without modifying the app's seed or saved conversation. Requests are serial and successful public pages are cached for one day. Access denial or HTTP 429 stops the run. The completed local run retained successful pages despite HTTP 422 timeouts. It did not complete every planned search.

Arctic Shift's [collection notes](https://github.com/ArthurHeitmann/arctic_shift/blob/master/file_content_explanations.md) distinguish initially moderated posts that were subsequently restored from posts deleted at the second retrieval. The adapter follows those fields, restores the documented edited title, and excludes later-deleted records. An archived public status is not a live verification claim.

## Public X export

Use the current [Community Archive export pointer](https://fabxmporizzqflnftavs.supabase.co/storage/v1/object/public/community-archive-public-export/latest.json), then follow its `manifest_url`. The manifest supplies the current tweets and profiles URLs, row counts, SHA-256 checksums and consent snapshot time. Download those current files and verify their checksums before extraction. The October 22 package contains 12,401,087 tweets, 939 eligible profile accounts and about 1.1 GB of tweet data.

Join tweet `account_id` to profile `account_id`, retaining only usernames whose account IDs occur in the same pointer's `eligible_account_ids`. Keep IDs as strings. Filter to recent original software asks and exclude retweets. Preserve `tweet_id`, `account_id`, `username`, `created_at`, `full_text`, `reply_to_tweet_id`, `retweeted_tweet_id` and `conversation_id` in JSONL. DuckDB can read these Parquet files directly; no model is needed for extraction. The normalizer applies further request-candidate and provenance checks:

```sh
node scripts/datasets.mjs \
  --provider community-archive \
  --input .atlas/datasets/community-archive/request-candidates.jsonl \
  --manifest .atlas/datasets/community-archive/manifest.json \
  --eligibility .atlas/datasets/community-archive/latest.json \
  --max-records 12000 \
  --output .atlas/datasets/community-x.json
```

Each retained X record carries its export ID, original X status URL, stable account ID, consent snapshot and source checksum. The source manifest publishes no explicit content license; the project's MIT code license is not substituted for a content license. The [privacy policy](https://www.community-archive.org/data-policy) describes public access and analysis. Archive membership does not grant consent to receive outreach.

For refresh, resolve the latest pointer again and rebuild this corpus from that package. Replace the preceding Community Archive export's records, then rerun problem analysis. An additive merge would retain authors or posts withdrawn from a later consent snapshot. Do not reuse superseded export URLs or historical `enriched_tweets.parquet` copies. The provider withdraws superseded packages and may temporarily remove downloads after consent changes. The current app snapshot is not an automatic consent refresh service.

The supported Community Archive API v1 requires a personal key from its [API key settings](https://www.community-archive.org/settings/api-keys). The legacy public Supabase REST API retires November 19, 2026; this implementation uses the supported bulk path for new work. The general X API remains a separate paid connection.

## Dataset exclusions and limits

The Williams and Mahmoud RE17 academic Twitter corpus was inspected through its [published replication package](https://zenodo.org/records/5733504). It contains original tweet IDs and 2016 dates but no original requester identities. It was excluded from demand counts and leads. An older Reddit corpus with encrypted author and original-URL fields was also excluded. Synthetic records, profile dumps, unattributable IDs and recovered deleted text are not accepted as requester evidence.

No LinkedIn dump has been ingested. LinkedIn coverage requires an independently obtained dataset that can lawfully be used. Public visibility alone does not grant reuse rights. The LocalLLaMA sample's noncommercial restriction is preserved in every record. A commercial product needs an appropriate source agreement or replacement corpus.

Only attributable post records are suitable for import. Each row needs:

- Original public post text of at least 20 characters.
- A public author or username.
- An original HTTPS post URL matching its platform.
- An original date, as a date string or Unix seconds/milliseconds.

Each dataset also needs its name, original HTTPS dataset/source page and license. These are recorded as provenance; the importer does not verify the publisher's rights or authenticate a license claim. Review that provenance before import. Profile dumps and synthetic records must be rejected, not relabeled as requests. X URLs must contain a status ID, LinkedIn URLs must be posts or feed updates, and Reddit URLs must identify posts/comments. An author profile URL is optional and supplements the original post link.

The importer supports `reddit`, `x` (`twitter` is normalized to `x`), `linkedin`, `hn`, `github` and `stackexchange`. Formats are CSV, JSON, JSONL and NDJSON. JSON accepts a top-level array or an object with a `records` or `data` array. The per-run limit is 50,000 rows. Invalid rows and canonical-URL duplicates are reported separately.

## Import CLI

Run from the project directory:

```sh
npm run import -- \
  --file /absolute/path/public-posts.jsonl \
  --source x \
  --name 'Dataset publisher and release' \
  --dataset-url 'https://publisher.example/datasets/public-posts' \
  --license 'Publisher-provided license expression or URL'
```

The command accepts exactly these string flags:

| Flag | Meaning |
| --- | --- |
| `--file` | Input CSV, JSON, JSONL or NDJSON path. |
| `--source` | Platform name. Without it, each row must provide a supported `source`. |
| `--name` | Dataset name recorded on accepted posts. |
| `--dataset-url` | Original HTTPS dataset/source page. |
| `--license` | Dataset license recorded for provenance. |
| `--text-column` | Override the post-text column. |
| `--author-column` | Override the public-author column. |
| `--date-column` | Override the original-date column. |
| `--url-column` | Override the original-post URL column. |
| `--title-column` | Optional title column. Otherwise the first 110 text characters become the title. |
| `--profile-column` | Optional public-author profile column. |

Default field aliases include `text`/`body`/`selftext`/`post_text`/`content`, `author`/`username`/`user`/`author_name`, `date`/`created_at`/`created_utc`/`timestamp`/`datetime`/`published_at`, and `url`/`permalink`/`post_url`/`original_url`.

The command prints accepted, duplicate and rejected counts, merges traceable posts into the cached corpus, and reruns request understanding and problem analysis. Model analysis uses GPT 6 Luna through the Codex subscription, with cached results; it consumes subscription allowance. Embeddings run locally, and the first pass may download the embedding model. It writes the updated snapshot to `data/seed.json`; restart the app to load it. If no posts are accepted, the existing snapshot is kept. Import does not connect a live provider or submit outreach.

## Merge normalized collection snapshots

Use the merge command to combine existing normalized collector and dataset outputs before analysis:

```sh
npm run merge -- \
  --input .atlas/expansion-ready.json \
  --input .atlas/datasets/reddit-combined.json \
  --input .atlas/datasets/community-x.json
```

`--base` defaults to `data/seed.json`. Repeat `--input` for each normalized JSON object with a `records` array. `--output` defaults to `.atlas/merged-input.json`. The output is written atomically and must be separate from every input. The command refuses seed, state and corpus destinations, including symbolic aliases. It makes no network requests or model calls, and does not publish the staging file to the app.

Canonical post URLs deduplicate changed slugs, tracking parameters and X/Twitter aliases while preserving separate comments. The first existing record ID and original post date remain stable. Record collection history, dataset revisions, numeric X account IDs and licenses are preserved. Feeds, collection runs, expansion attempts and dataset reports remain in the output as provenance. Invalid non-post records are rejected with their source ID, URL and reason in `merge.rejected`. A conflicting original date or reused record ID fails the merge.

Old request classifications, counts, memberships and problem groups are cleared. `analysis.status` becomes `pending`; the merged file must pass the analysis pipeline before its posts count as demand. A cached public copy cannot reopen a deleted, removed, closed or resolved source. Reopening requires an explicit later `liveVerified: true`, at the record level or in dataset metadata. Deleted and removed records become redacted reference tombstones.

Community Archive has an additional selection boundary. The first eligible export can merge into a base without prior Community Archive records. An unchanged selection can roundtrip only when its export ID, checksum, consent snapshot, canonical post set and authored content match. A changed export, changed consent snapshot, partial selection or invalid archive row fails the merge. The current normalized format does not prove a complete current eligibility refresh, so the command does not add a new export onto an old one or infer withdrawals from missing search results. A future refresh must verify current account eligibility and the complete selected export, replace the preceding provider selection, and retain redacted tombstones for withdrawn references.
