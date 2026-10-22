# Internet Atlas

Find explicit software requests in public discussion, inspect their evidence, shape an idea and prepare the first conversation.

Two linked graphs share one Codex agent. The app runs on your computer at **http://localhost:3000**.

![Original v1 interface](docs/atlas.png)

The screenshot shows the original v1 layout. The current graph uses looser neighborhoods and request groups.

## Run

Requires Node 22+ and the Codex CLI, signed in with your ChatGPT account.

```sh
npm install
codex login
npm run dev
```

Open http://localhost:3000. The agent connects automatically. Use **Connect Codex** to retry if needed. Every model turn uses **GPT 6 Luna**, enforced in the backend. No OpenAI API key is required. Tested with Codex CLI 0.163.0 and its experimental dynamic tool protocol.

```sh
npm test
npm run build
npm start
```

`npm start` serves the production build. Stop a running dev server before starting it on the same port. Optional environment settings are in [.env.example](.env.example). Keep credentials in `.env.local`, which is ignored by Git.

## Use

1. Open **Requests** to inspect grouped asks, requester counts, tiers and original quotes. Use **Topics** or search to explore the wider corpus. Select a source to read its author, date and original post, then pin useful evidence.
2. Ask Atlas to investigate a problem or collect more requests for a specific need. White rings mark cited sources; click a citation to inspect its evidence. Create or edit an idea with a clear audience, workflow and supporting sources.
3. Choose **Find people**. Each person connects to their supporting sources. Dashed links indicate inferred relevance.
4. Check a public profile, then draft a DM or email. Edit, save, copy or export the result. The app has no send endpoint.

The same agent stays with both graphs. It reads sources and request groups, runs targeted searches of Hacker News and public Reddit RSS, rebuilds groups, focuses evidence, saves ideas, finds people, checks public profiles and saves drafts. Responses come from the connected model. Provider errors and partial coverage remain visible; the model can be stopped.

Editing the idea invalidates previous leads and drafts. Drafts are tied to the current idea revision. Saved research can be exported as Markdown.

## Public data and cost

The October 22, 2026 snapshot contains **3,021 public records and 1,010 detected candidate asks**. No inferred group reaches 10 distinct recent requesters. The app opens the cached snapshot without fetching fresh sources. Curated collections cover agents, retrieval, data infrastructure, testing, observability, integrations, authentication, billing and general software requests. Coverage is a sample, not a census of the internet.

| Source | Use | Access |
| --- | --- | --- |
| [HN Algolia API](https://hn.algolia.com/api) | Public asks, comments and original discussion links | Free, no key |
| [Hacker News API](https://github.com/HackerNews/API) | Public bios and source rechecks | Free, no key |
| [GitHub REST API](https://docs.github.com/en/rest) | Public feature requests, selected comments and profiles | Free, 60 ordinary requests/hour without a token; optional `GITHUB_TOKEN` increases limits; search is separately limited |
| [Reddit RSS](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026) | Public subreddit search feeds | Currently no key; RSS ends November 13, 2026; new API access requests close October 31 |
| [Stack Exchange API](https://api.stackexchange.com/docs) | Software Recommendations questions with attribution and license information | Provider quotas and access controls apply; failures surface as unavailable coverage |
| [Codex app-server](https://developers.openai.com/codex/app-server) | The local agent, using managed ChatGPT authentication | Uses your existing subscription and its usage limits |

No additional paid data or embedding service is required. The local MiniLM model is downloaded on first analysis and cached for reuse. Codex uses your existing subscription limits. Refreshes are paced and preserve previous records when a source fails. The refresh button updates the local cache; `npm run ingest` fetches sources, analyzes requests and rebuilds the versioned seed. `npm run analyze` reanalyzes the cached corpus.

X is not connected and requires developer-console setup and pay-per-usage API access. No X or LinkedIn dump has been ingested. Traceable external post datasets can be imported with `npm run import`. See [data sources and the import CLI](docs/data-sources.md) for exact flags, required author/post/date/text fields, dataset provenance and license requirements. Profile dumps and synthetic records are not request evidence.

Sources retain their original URLs, public usernames, dates and retrieval timestamps. Text remains attributable to its original authors. Public profiles may contain self-reported affiliations or email addresses. The app never infers an email from a name or domain.

## How the graph works

Explicit ask rules identify candidate product searches and feature requests. Local embeddings from `Xenova/all-MiniLM-L6-v2` group similar needs, with a similarity guard against chaining unrelated requests together. Membership is inferred and needs review against the literal source quotes.

Tiers count distinct public accounts making explicit requests in the past 365 days: **10+ Recurring, 20+ Growing, 50+ Strong**; smaller groups are Early. Canonical URLs, long copied posts and repeated requests by one account do not inflate the count. Votes, brief endorsements, promotions, bots and closed or removed posts are excluded. Historical and dataset evidence retains its original dates. Accounts on different platforms may belong to the same person. No tier establishes willingness to pay.

The discovery graph contains curated collection hubs, source records, public authors and request groups. Solid links show authorship and collection assignment; dashed links show inferred semantic membership or idea relevance. Detected request sources are larger than general discussion. White rings identify cited evidence. Node size does not measure market size. Stable positions keep inspection from rearranging the map.

Search and lead ranking combine lexical relevance, collection context, request-group membership and provenance. Public authors may be users, competitors or experts. People are candidates for an interview, not validated customers.

The agent reads the same records through bounded tools. It can investigate beyond a short excerpt by retrieving the full cached source. Before drafting, it is instructed to check the public profile and refresh supporting evidence. Closed or removed sources are flagged; removed content is redacted locally after a successful recheck. Network failures remain unverified rather than being reported as successful checks.

## Local data and privacy

- `.atlas/` stores your idea, pins, conversation, profiles and drafts. It is ignored by Git.
- The child Codex app-server manages its own authentication. The app does not read or copy OAuth credentials.
- Your requests, current UI context and evidence retrieved by tools are sent to the cloud model. Nothing is sent to outreach recipients.
- The API binds to `127.0.0.1` and checks request hosts and browser origins. It is intended for local, single-user use.
- The child agent uses a read-only sandbox with shell, apps, browser, plugins and subagents disabled. Only Atlas tool requests are serviced by the app.

## Design

Geist Mono, Hugeicons' free Stroke Rounded set, neutral charcoal surfaces, consistent community colors and a tall, inset agent panel. Nested panel corners follow the available padding. Motion is short and reduced-motion preferences are respected.

Graph exploration is inspired by [Graphify](https://github.com/Graphify-Labs/graphify). Interface references include Codex, Cursor, Grok Bot, [Agents with Taste](https://emilkowal.ski/ui/agents-with-taste), [Beautiful UI](https://www.beautifului.dev/), [affectUI](https://www.affectui.com/screens), [OpenUI](https://github.com/thesysdev/openui), [Transitions](https://transitions.dev/) and [React Bits](https://reactbits.dev/). The graph uses `vis-network` and `vis-data`; Graphify's Python pipeline is not a runtime dependency.

## Project map

- `src/`: React interface, graph and agent dock
- `server/data.mjs`: local cache, search, ideas, lead matching and drafts
- `server/sources.mjs`: public-source ingestion and targeted request collection
- `server/requests.mjs`: explicit ask rules and 10/20/50 requester tiers
- `server/signals.mjs`: local embeddings, semantic groups and dated author counts
- `server/imports.mjs`: external-post validation and dataset provenance
- `shared/citations.mjs`: canonical source URLs and citation matching
- `server/agent.mjs`: Codex JSON-RPC bridge and Atlas tools
- `server/index.mjs`: local API, SSE and web server
- `data/seed.json`: source-linked public snapshot
- `scripts/ingest.mjs`, `scripts/analyze.mjs`, `scripts/import.mjs`: fetch, analyze and import CLIs
- `tests/workflow.test.mjs`, `tests/signals.test.mjs`: workflow, provenance, counting, grouping, import and citation checks
- `docs/data-sources.md`: provider access notes and import flags
