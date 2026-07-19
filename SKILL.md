---
name: verlio
description: Check whether a merged GitHub pull request left the project's documentation stale, and optionally open a real pull request with the drafted fix. Use when asked to check for doc drift, verify docs are up to date after a merge, or find PRs whose behavior changes aren't reflected in the README/docs.
---

# Verlio — Documentation Sync Agent

Verlio watches a repo's merged pull requests, classifies whether the code change is
documentation-relevant, and drafts a fix. **It never auto-merges** — every fix arrives as an
ordinary pull request for a human to review.

## Install (one command)

```sh
claude mcp add verlio -- npx -y verlio-mcp
```

(Cursor: add the same `npx -y verlio-mcp` command as a stdio MCP server in its MCP settings.)

Requires `ANTHROPIC_API_KEY` and either `GITHUB_TOKEN` (personal access token, `repo` scope) or
the `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_APP_INSTALLATION_ID` trio, set as environment
variables wherever the MCP server process runs. No signup, no hosted account, no dashboard.

## Tools this skill gives you

| Tool | Side effects | When to use it |
|---|---|---|
| `check_docs_drift` | None — read-only | The user wants to know *whether* a merged PR needs a docs update, without acting on it. Always try this first if there's any doubt. |
| `open_docs_pr` | Opens a real PR on the repo (never merges) | The user has confirmed they want the fix opened as an actual pull request for review. |

Both tools take the same input: `repo` (`"owner/name"`) and `pr_number` (the merged PR's number).
Both return the same structured JSON — a `relevant` boolean, a `confidence` score, `rationale`,
and (when confident enough to matter) a `draft` summary of what would change. `open_docs_pr`
additionally returns `pr_opened: { url, number }` when it actually opens something.

## How to use this

- If the user names a specific merged PR ("did #482 need a docs update?", "check this merge for
  stale docs"), call `check_docs_drift` directly — it's read-only, no need to ask first.
- If the user wants the fix actually filed ("open the docs fix", "yes, file that PR"), call
  `open_docs_pr`. Since this creates a real, publicly-visible pull request, treat it like any
  other action that publishes content: confirm with the user first if they haven't already asked
  for the PR to be opened in the same turn.
- Verlio scores its own confidence. A `relevant: true` result with `confidence` below ~0.6 means
  Verlio itself doesn't recommend acting on it — say so plainly rather than treating every
  `relevant: true` the same way.
- Verlio is public-repos-only in this phase. If a tool call fails with an auth/permission error
  against a private repo, that's expected, not a bug to route around.

## What this is not

- Not a linter or CI check — it looks at one merged PR at a time, on request.
- Not a doc generator for a whole repo — it only reacts to a diff, and only drafts an edit when
  it can point at a specific documented surface the diff actually changed.
- Never opens a PR with `merge` permissions and never merges anything itself, regardless of how
  confident the classification is.
