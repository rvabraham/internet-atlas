# Data sources and imports

Access notes are current as of October 22, 2026.

Internet Atlas counts distinct public authors making explicit requests. The count uses a rolling 365-day window, excludes future-dated posts, and changes tier at 10, 20 and 50 requesters. Reactions, generic mentions and brief endorsements do not become request counts. Similarity groups and lead relevance are inferred. They do not establish purchase intent or market size.

## Connected sources

| Source | Access used by this app | Limits and interpretation |
| --- | --- | --- |
| [HN Algolia](https://hn.algolia.com/api) and [HN API](https://github.com/HackerNews/API) | Public search, original discussions and public source/profile checks. No key required. | Queries sample public discussion. Results are not complete internet coverage or evidence of buying authority. |
| [GitHub REST API](https://docs.github.com/en/rest) | Public open issues and selected authored comments. An optional `GITHUB_TOKEN` raises the ordinary unauthenticated limit of 60 requests/hour. | Search has a separate limit. Closed issues, promotions and bots are excluded from request counts. Multiple requests by one platform author count once per signal. |
| [Reddit RSS](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026) | Public subreddit search feeds currently work without keys. Failures are reported as unavailable coverage. | Reddit's October 8, 2026 changelog says RSS ends November 13, 2026 and new API access requests close October 31, 2026. This is temporary access, not a durable or guaranteed free Reddit integration. |
| [Software Recommendations on Stack Exchange](https://api.stackexchange.com/docs) | The adapter reads public questions without a key and preserves attribution/license information. | Availability and quotas are controlled by the provider. Failed reads remain unavailable. A recommendation question is evidence of a stated need, not budget or purchase intent. |

The snapshot retains each post's original URL, public author, original date and retrieval time. A public profile is a reply path, not permission to contact someone. Cross-platform identities are not inferred. Atlas has no outreach send endpoint.

## Getting Reddit and X access

For Reddit, [submit the Data API access form](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164) with this app's purpose and data needs, then follow the credentials flow if approved. New requests close October 31, 2026. [Register the app on the Developer Platform](https://developers.reddit.com/) and review the migration path. [Commercial use requires Reddit's permission and a contract](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data). Do not assume that registering produces unrestricted search access. This app currently uses public RSS, not an authenticated Reddit adapter.

For X, use the [Developer Console](https://console.x.com/) to set up developer access and an app, generate its bearer token, and configure a spending limit before enabling paid reads. The [current pricing page](https://docs.x.com/x-api/getting-started/pricing) lists $0.005 per public post read and $0.010 per user read, so 1,000 post reads alone would cost $5. Rates and endpoint access can change. Do not paste tokens into chat. A live X adapter still needs to be connected once access is available; the current importer uses no token and makes no paid calls.

## X, LinkedIn and external datasets

No X or LinkedIn dump has been ingested. X is not connected. X API access requires a developer-console setup and pay-per-usage access. LinkedIn coverage requires an independently obtained dataset that can lawfully be used. Public visibility alone does not grant reuse rights.

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

The command prints accepted, duplicate and rejected counts, merges traceable posts into the cached corpus, and reruns local embedding analysis. A first analysis may download the embedding model. It writes the updated snapshot to `data/seed.json`; restart the app to load it. If no posts are accepted, the existing snapshot is kept. Import does not connect a live provider or submit outreach.
