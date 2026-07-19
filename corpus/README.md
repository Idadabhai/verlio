# Classifier Test Corpus

`labeled-prs.json` — 46 real merged pull requests from 8 well-known public TypeScript/JavaScript
repos (axios, express, hono, zod, commander.js, got, octokit.js, lodash), each read and labeled
by hand as `docs-relevant` or `not-relevant` for whether the code diff warrants a documentation
update. No synthetic examples.

## Methodology
1. Pulled recent merged PRs per repo via `gh pr list --state merged --json ...`.
2. Fetched each candidate's full diff via `gh pr diff`.
3. Read the actual diff (not just the title) before labeling — several PRs are mislabeled by
   their title alone (e.g. axios#11062 is titled "refactor" but ships a real behavior fix;
   express#7234 is titled as a dependency upgrade but changes `res.send()`'s documented output;
   lodash's "docs:"-titled PRs turned out to have zero source-code diff and were excluded from
   being counted as positive signal for that reason).
4. Labeling rule applied: does this diff change something a maintainer's docs/README/changelog
   would need to describe accurately afterward? Pure CI/dependency/test/comment/internal-refactor
   diffs are `not-relevant`; new/changed public API surface, changed documented option behavior,
   and security-relevant behavior fixes are `docs-relevant`.

## ⚠️ This file is the DEV (tuning) set — it cannot produce a valid gate number

Six entries in this corpus are quoted verbatim, with their labels and rationales, as worked
examples inside `CLASSIFY_SYSTEM_PROMPT` in `lib/ai.ts` (axios#11062, express#7234,
octokit#2903, lodash#6249, zod#5898, lodash#6170). They were added during M1 to pad the prompt
past the minimum cacheable prefix length — see `verlio_CHANGELOG.md`. Measuring precision here
is an open-book exam.

**Use `heldout-prs.json` for any gate measurement.** That set is drawn from eight repos with
zero overlap with this one and is never shown to the prompt. This file is for tuning only.

## Post-M1 label corrections

Corrections are recorded here so the answer key's history is auditable. **Rule: a label is only
corrected on evidence independent of the classifier's output** (the diff contents, or an
inconsistency with this file's own stated methodology). A label is never changed merely because
the classifier disagreed with it — that would fit the answer key to the thing being measured.

| Entry | M1 label | Corrected to | Grounds |
|---|---|---|---|
| axios/axios#11059 | not-relevant | docs-relevant | The diff edits `PRE_RELEASE_CHANGELOG.md`. Four sibling entries (axios#11081, axios#11071, zod#5929, got#2466) use "maintainers updated docs in this same PR" as decisive for docs-relevant. The original label contradicted the methodology in step 4 below. Corrected 2026-07-19 (M2). |

Considered and **not** corrected: `lodash#6178`. The classifier argued it fixes a `ReferenceError`
in the documented `_.template`; the diff does show `assignInWith`→`assignWith` (own vs. inherited
keys — a real behavior change) plus a README edit, but "ReferenceError" is an inference the diff
does not support and the original reading is defensible. Left as `not-relevant`.

## Composition
- 46 total: 19 `docs-relevant`, 27 `not-relevant` after the axios#11059 correction above
  (was 18/28 as M1 shipped it). Real-world skew — most merged PRs are chores, CI, or internal
  refactors, matching Nevo David's "bias toward precision" guidance in CLAUDE.md.
- Each entry: `repo`, `pr_number`, `url`, `title`, `label`, `rationale` (why, referencing what was
  actually in the diff).

## Use
M2 (classifier tuning) runs the pipeline's `classifyDiff()` against each entry's real diff (fetch
fresh via `lib/github.ts`, not stored locally) and compares to `label`, tracking false positives
(noisy relevant-when-not) and false negatives separately per PROJECT_BRIEF.md's M2 exit gate.
