# Verlio

Watches your repo's merged pull requests, checks whether the change made your docs (README,
`docs/`, etc.) stale, and opens a pull request with the fix. **It never merges anything —**
every fix arrives as an ordinary PR for you to review, same as any other contributor's.

Example: a PR adds a third argument to a function. Verlio notices the README's usage example still
shows two, drafts the update, and opens a PR against your default branch.

Free. Open-source. MIT-licensed.

## Try it with no install

Paste a public repo URL at **[verlio.dev](https://verlio.dev)** and see what Verlio would have
flagged on its last few merged PRs — no signup, no install.

## Install

**GitHub App (recommended)** — [github.com/apps/verlio-dev](https://github.com/apps/verlio-dev).
Scoped to `Contents` + `Pull requests` only — no merge permission, no admin access, nothing beyond
opening a PR for you to approve. Installs in under a minute.

**MCP server** (Claude Code, Cursor, or any MCP-compatible agent):
```sh
claude mcp add verlio -- npx -y -p verlio verlio-mcp
```
See [`SKILL.md`](./SKILL.md) for the tools this exposes (`check_docs_drift`, `open_docs_pr`) and
how an agent should use them.

**CLI:**
```sh
npx verlio <owner/repo> <pr-number> --dry-run
```

The GitHub App needs no extra setup once installed. The MCP server and CLI need `ANTHROPIC_API_KEY`
and either `GITHUB_TOKEN` or a `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_APP_INSTALLATION_ID`
trio set as environment variables.

## How it works

1. A PR merges into your repo.
2. Verlio reads the diff and classifies whether it changed anything your docs currently describe
   — a function signature, a CLI flag, a config option, documented behavior.
3. If it did, Verlio drafts the doc update and opens a PR explaining what changed and why.
4. You review it like any other PR. Merge it, edit it, or close it — Verlio never merges on its
   own, at any confidence level, in any phase.

## Scope, on purpose

- Public repos only, right now.
- Markdown docs only, right now.
- The GitHub App's permissions are `Contents: write` + `Pull requests: write` — nothing else. No
  admin, no merge capability. This is enforced twice: once by the permission grant itself, and
  again in code, where the merge API call is deliberately blocked so an accidental call fails
  loudly instead of reaching GitHub.

## Status

Early. Verlio is running a small soft launch on real repos right now, not a mature, widely-used
tool yet — if you install it and a PR it opens is wrong, unhelpful, or just annoying, that
feedback is genuinely more valuable to me than a merge. Open an issue, or reply if you got here
from an email.

## License

MIT — see [LICENSE](./LICENSE).
