# V1 verification

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
