# Internet Atlas

Explore public product requests, develop an idea and find the people who asked for it.

## Requirements

- Node.js 22 or later
- Codex CLI installed and signed in with your ChatGPT account

## Setup

```sh
npm install
codex login
npm run dev
```

Open http://localhost:3000. The agent connects through your existing Codex sign-in and uses GPT 6 Luna. No OpenAI API key is required. Use **Connect Codex** if the connection needs to be retried.

For a production build:

```sh
npm run build
npm start
```

Stop the development server before starting production on the same port.

## Use

1. Explore **Requests**, **Topics** or semantic search. Select a problem to inspect its requester count and original evidence. Use **Related** to follow similar nodes, and **Saved** to bookmark a problem.
2. Ask Atlas to investigate an opportunity or develop your own idea. Sources pulse as the agent reads or cites them. Supporting evidence stays outlined in white when the answer finishes.
3. Choose **Use this idea** or **Use in idea**, edit the proposal and select **Find leads**. The **Leads** graph connects your idea to its actual requesters and source posts.
4. Select a requester to inspect their evidence and public profile. Generate or edit a DM or email, then save, copy or export it. Messages stay in drafts.

Use **365d / All time** to distinguish recent and historical requests. Counts represent distinct public accounts with explicit requests, not votes or confirmed customers. Semantic similarity helps navigation and does not add demand.

The app opens a cached public-data snapshot. **Source health** shows coverage, pending analysis and collection failures. **Refresh public sources** fetches and analyzes new data and can take several minutes. Source attribution and dataset licensing are retained on individual records.

## Configuration and local data

Optional settings are listed in `.env.example`. Put credentials in `.env.local`, which is ignored by Git. An optional `GITHUB_TOKEN` increases ordinary GitHub API limits.

The app binds to `127.0.0.1` for local, single-user use. Your idea, conversation, saved problems and drafts stay in the ignored `.atlas/` directory. Prompts and retrieved evidence are sent to the cloud model. Nothing is sent to outreach recipients.

To use a separate local workspace:

```sh
PORT=3001 ATLAS_DIRECTORY=/absolute/path/to/workspace npm start
```

## Checks

```sh
npm test
npm run build
```
