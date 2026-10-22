# Verification

## Problem discovery and requester leads

Checked locally on October 22, 2026. Production runs at http://localhost:3000. Tests use isolated workspaces on port 3001.

**VERIFIED:** a vague prompt can survey indexed problems and produce a cited recommendation; selecting that problem generates its requester graph and an editable outreach draft. Final citations receive white outlines and are framed together.

- 93 automated checks pass. They cover structured GPT 6 Luna jobs, literal quotes, cache invalidation, model rejection, singleton retention, semantic splits, historical windows, source/account integrity, selected-problem and custom-idea leads, cancellation, repeated citation events, final-answer-only citations, and discovery protecting the chosen idea and drafts.
- The seed contains 3,430 public posts: 1,882 Hacker News, 860 GitHub, 194 Reddit and 494 Software Recommendations. There are 891 quote-validated requests and 872 indexed problems. The classifier analyzed 1,558 of 1,663 candidates; 105 failed validation and remain outside reviewed demand. The largest current group has 2 distinct requesters, and the largest historical group has 5. No group reaches 10. GitHub deleted-account placeholders do not count as attributable requesters.
- Collected 409 additional real posts using eight workflow query families. Reddit returned 429 after its first successful feed, so its collection stopped. No paid data API was used. Model analysis uses the existing Codex subscription; embeddings run locally with a pinned model revision.
- A fresh GPT 6 Luna session received only `What should I build?`, with no selected node, attached evidence, or prior conversation. It surveyed the index, compared three groups across different workflows, searched alternatives and read original evidence. The final live trace is summarized in [agent-verification.json](agent-verification.json). Repeated vague-prompt checks exposed an unsolicited idea save; the final server now blocks idea, lead and draft mutations during exploratory requests, with a regression protecting existing state.
- Browser checks at 1280×720 verified final citation framing, reviewed-label search, original quotes, historical/current count separation, Use in idea, both actual requester accounts in Leads, and a saved DM using the same agent. GitHub profile refresh returned 403; the agent disclosed it and did not invent an email. No outreach was sent. Browser console errors: none.
- Artifacts: [vague discovery](atlas-vague.png), [request inspector](atlas-requests.png), [leads graph](atlas-leads.png), [draft](atlas-draft.png), [compact viewport](atlas-compact.png).
- The user's original two-message conversation, idea, leads and drafts remained unchanged. The state digest is recorded in [verification.json](verification.json), together with the declared source inputs and hashes of bytes fetched from localhost. The UI tests use production assets.

Limits: model understanding and semantic grouping are inferences. Public account counts do not establish buying intent. Coverage remains a sample, with X and LinkedIn not connected. Transient pulses have event-level regression coverage and live reference traces; the saved still images verify the completed white outlines and framing.

## Previous request intelligence update

Checked locally on October 22, 2026. The running production app is http://localhost:3000.

- Build succeeds and 36 automated tests pass. Checks cover request filtering, semantic chain protection, 10/20/50 tier boundaries, account and URL deduplication, date windows, source removal, dataset provenance, rejected profile/synthetic rows, citations, conversation migration and the existing idea/draft workflow.
- The served snapshot contains 3,021 original records: 1,653 Hacker News, 709 GitHub, 165 Reddit and 494 Software Recommendations records. The local classifier identifies 1,010 candidate asks in 1,001 inferred groups. The largest group has three recent accounts. No group reaches the recurring tier.
- A targeted live webhook collection returned 180 HN comments and 95 Reddit records before deduplication. No paid data API was called. MiniLM embeddings run locally with the model revision pinned to `751bff37182d3f1213fa05d7196b954e230abad9`.
- An isolated live GPT 6 Luna turn called `atlas_signals`, `atlas_get_signal` and `atlas_focus`. It correctly reported one recent requester, the Early tier, and the original SigNoz issue URL. The tool upgrade preserved prior conversation context.
- The user's existing two-message conversation remained unchanged through the production restart. Both original webhook citations resolve to indexed graph sources. No user state was cleared.
- **VERIFIED** in the built-in browser at 1280 × 720: the loose graph renders, both original citations have white outlines, and citation selection opens the original evidence with its node visible beside the inspector. A focus bug that hid selected nodes behind the inspector was reproduced, fixed and checked against the same source and viewport. The request inspector shows three authored requests, the Early tier and the 10/20/50 thresholds. Use in idea carries all three original sources into the editor. The modal was closed without saving. Browser console errors: none. Artifacts: [overview](atlas.png), [citation focus](atlas-citation.png), [request inspector](atlas-requests.png).
- Production HTML, JavaScript and CSS were fetched from localhost and matched against the built files. [verification.json](verification.json) records the source boundary, its combined SHA-256 digest, individual input hashes and served artifact hashes. It includes source and generated data, dependency lockfile and build configuration.

Known limits: request detection uses explicit-ask rules, grouping is inferred, and this sample has limited recurring demand. X and LinkedIn are supported through traceable dataset imports, with no X or LinkedIn dump ingested. Reddit RSS currently works but is scheduled to end November 13, 2026. Cross-platform accounts are not verified unique people. No outreach was sent.

## Original v1 verification

Checked locally on October 22, 2026.

- Production build serves successfully on localhost.
- Ten automated tests cover deduplication, provenance, topic relevance, lead ranking, idea revision invalidation, persistence, local origin checks and GPT 6 Luna enforcement.
- Browser checks covered search, original-source inspection, pinning evidence, creating an idea, generating the second graph, opening a person, saving and copying drafts.
- The live Codex bridge used GPT 6 Luna through the existing ChatGPT sign-in. It researched `MasterC1980` and the original [n8n issue](https://github.com/n8n-io/n8n/issues/22112), rechecked that issue, and saved a DM and an email through Atlas tools.
- The email recipient stayed blank because the public profile did not publish an email address.
- Markdown export contained the idea, people, original source links and both drafts. A send request returned 404. A foreign browser origin was rejected with 403.
- The desktop composition was checked at 1440 × 900, with a narrower layout checked in the Codex browser panel.

The test conversation, idea and drafts were removed from the starting workspace after verification. A local QA snapshot and export remain in the ignored `.atlas/` directory.

Scope: eight curated collections from Hacker News and GitHub. Similarity and person relevance use lexical matching. Results require interpretation and do not establish purchase intent. No outreach was sent.
