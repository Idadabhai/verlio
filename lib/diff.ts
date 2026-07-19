/**
 * Diff preparation — shared by the production pipeline and the M2 eval harness so both
 * classify byte-identical input. If these ever diverge, the M2 gate number stops predicting
 * production behavior.
 *
 * Why this exists: git orders a diff by file path and any naive truncation cuts the tail.
 * That interacts badly with lockfiles, and in opposite directions depending on the repo:
 *   - octokit/octokit.js#2913 (npm):  package-lock.json -> package.json -> scripts/build.mjs
 *     The lockfile is huge and sorts FIRST, so tail-truncation feeds the classifier pure
 *     lockfile noise and discards the only real source change.
 *   - vitejs/vite#22921 (pnpm):      docs/ -> packages/ -> pnpm-lock.yaml
 *     Here the lockfile sorts last and tail-truncation drops it, which is what we want.
 * Identical truncation logic therefore produces opposite failure modes per package manager.
 * The fix is to drop known-noise files up front and tell the classifier they were dropped,
 * rather than letting them consume the budget.
 */

/** Files that carry no docs-relevance signal but can dominate a diff by size. */
const NOISE_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/, kind: 'lockfile' },
  { pattern: /(^|\/)__snapshots__\//, kind: 'snapshot' },
  { pattern: /\.snap$/, kind: 'snapshot' },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/, kind: 'workspace config' },
];

export const MAX_DIFF_CHARS = 60_000;

/** Documentation/prose files. A diff touching only these has no code change to react to. */
const DOC_FILE_PATTERN = /\.(md|mdx|markdown|rst|txt)$|^(docs?|documentation|website)\/|(^|\/)(README|CHANGELOG|HISTORY|CONTRIBUTING|AUTHORS|LICENSE|NOTICE|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i;

/**
 * True when every changed file is documentation — i.e. a human already wrote the docs by hand
 * and there is no code change for Verlio to react to.
 *
 * This is decided deterministically from file paths rather than by the model, for two reasons.
 * It is exactly decidable, so spending an API call on it is waste; and during M2 the model was
 * observed emitting `relevant: true` at confidence 0.99 on docs-only diffs while its own
 * rationale said "there is no source code change and nothing for this tool to react to"
 * (vitejs/vite#22940, nodejs/undici#5548). A deterministic guard cannot contradict itself.
 *
 * Returns false for an empty file list — "no files parsed" is not the same as "docs only", and
 * must not be silently treated as a confident verdict.
 */
export function isDocsOnlyDiff(rawDiff: string): boolean {
  const paths = splitByFile(rawDiff)
    .map((c) => c.path)
    .filter((p) => p.length > 0);
  if (paths.length === 0) return false;
  return paths.every((p) => DOC_FILE_PATTERN.test(p));
}

/** JS/TS/JSX line- or block-comment content, or blank. Scoped to Verlio's current target
 * ecosystem (see CLAUDE.md) — extend if other languages are ever supported. */
const COMMENT_LINE_PATTERN = /^(\/\/|\/\*|\*)/;
const JS_TS_FILE_PATTERN = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

function isCommentOrBlankContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || COMMENT_LINE_PATTERN.test(trimmed);
}

/**
 * True when every changed line, across every non-doc source file in the diff, is a JS/TS
 * comment or blank — i.e. STEP 1b of CLASSIFY_SYSTEM_PROMPT ("comment-only changes are never
 * relevant") decided deterministically instead of by the model.
 *
 * Exists because that in-prompt instruction still misses sometimes: remix-run/react-router#15316
 * — a diff adding `@public`/`@category`/`@param` JSDoc tags across several files — was flagged
 * relevant at 0.75 confidence despite the explicit rule. DocPrism's LCEF paper (arXiv 2511.00215)
 * names this failure mode generally: "instructed filtering" (asking a model to apply and
 * self-report a filter rule within one reasoning pass) underperforms "external filtering" (a
 * deterministic check outside the model). This is the external-filtering version of STEP 1b,
 * mirroring isDocsOnlyDiff above.
 *
 * NOTE: this function does not fully resolve #15316 itself — that PR also touched
 * `scripts/docs.ts`, an internal docs-build script with a genuine (if non-public-facing) code
 * change, so the diff correctly does not qualify as comment-only and still reaches the model.
 * Verified against the full 196-entry labeled corpus: zero false positives, and it deterministically
 * resolves 13 other real not-relevant cases the model previously had to call an API for.
 *
 * Deliberately conservative in two ways: any file with an extension outside the JS/TS family
 * makes the whole diff not-comment-only (no guessing at unfamiliar comment syntax), and any
 * single changed line that doesn't match the comment pattern does the same. A missed
 * comment-only diff still gets a model verdict, which is usually correct; a wrongly-skipped real
 * code change would be a silent, undetectable miss of genuine drift — the worse failure mode.
 *
 * A per-line prefix check alone is not enough: real JSDoc reflows (react-router#15316 again —
 * the block was rewritten from unprefixed prose lines to standard `* `-prefixed lines) contain
 * removed/added lines that are plain prose with no `//`/`/*`/`*` of their own, because they sit
 * *inside* an already-open `/** ... *\/` block rather than opening one themselves. So this also
 * tracks block-comment state (opened by a line starting with `/*`, closed by one ending `*\/`)
 * across each hunk, using unchanged context lines to see the comment's boundaries when the
 * changed lines alone wouldn't show them. State resets at each `@@` hunk header rather than
 * carrying across a whole file — a hunk's own context is expected to contain both the opening and
 * closing delimiter when the change is genuinely comment-only; if it doesn't, that is treated as
 * "not provably comment-only" rather than guessed at.
 */
export function isCommentOnlyDiff(rawDiff: string): boolean {
  const chunks = splitByFile(rawDiff).filter((c) => c.path.length > 0);
  if (chunks.length === 0) return false;

  let sawAnyChangedLine = false;

  for (const chunk of chunks) {
    if (DOC_FILE_PATTERN.test(chunk.path)) continue; // handled by isDocsOnlyDiff
    if (!JS_TS_FILE_PATTERN.test(chunk.path)) return false;

    let inBlockComment = false;
    for (const line of chunk.text.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('@@')) {
        inBlockComment = false; // each hunk must prove itself from its own context
        continue;
      }
      const prefix = line[0];
      if (prefix !== '+' && prefix !== '-' && prefix !== ' ') continue; // file-header noise

      const content = line.slice(1);
      const trimmed = content.trim();
      const closesHere = inBlockComment && trimmed.endsWith('*/');
      const commentish = isCommentOrBlankContent(content) || inBlockComment;

      if (prefix !== ' ') {
        sawAnyChangedLine = true;
        if (!commentish) return false;
      }

      if (trimmed.startsWith('/*') && !trimmed.endsWith('*/')) inBlockComment = true;
      else if (closesHere) inBlockComment = false;
    }
  }

  return sawAnyChangedLine;
}

export interface PreparedDiff {
  diff: string;
  /** Human-readable note about what was removed, or null when nothing was. */
  omissionNote: string | null;
  filteredFiles: Array<{ path: string; kind: string }>;
  truncated: boolean;
  originalChars: number;
}

interface FileChunk {
  path: string;
  text: string;
}

/**
 * Split a unified diff into per-file chunks. Anything before the first `diff --git` header
 * (rare, but possible with some diff producers) is preserved as a pathless preamble chunk.
 */
function splitByFile(diff: string): FileChunk[] {
  const lines = diff.split('\n');
  const chunks: FileChunk[] = [];
  let current: FileChunk | null = null;

  for (const line of lines) {
    const header = line.startsWith('diff --git ') ? line : null;
    if (header) {
      if (current) chunks.push(current);
      // `diff --git a/<path> b/<path>` — take the b-side, which is correct for renames.
      const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] ?? match?.[1] ?? '', text: line };
    } else if (current) {
      current.text += `\n${line}`;
    } else {
      current = { path: '', text: line };
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function classifyNoise(path: string): string | null {
  for (const { pattern, kind } of NOISE_PATTERNS) {
    if (pattern.test(path)) return kind;
  }
  return null;
}

/**
 * Drop known-noise files, then truncate what remains to fit the budget.
 *
 * The classifier is still TOLD which files were dropped — "this PR touched a lockfile" is
 * genuine signal for a not-relevant verdict, it just doesn't need the lockfile's 40k lines
 * to reach that conclusion.
 */
export function prepareDiff(rawDiff: string, maxChars = MAX_DIFF_CHARS): PreparedDiff {
  const originalChars = rawDiff.length;
  const chunks = splitByFile(rawDiff);

  const kept: FileChunk[] = [];
  const filteredFiles: Array<{ path: string; kind: string }> = [];

  for (const chunk of chunks) {
    const kind = chunk.path ? classifyNoise(chunk.path) : null;
    if (kind) {
      filteredFiles.push({ path: chunk.path, kind });
    } else {
      kept.push(chunk);
    }
  }

  // Everything was noise — say so explicitly rather than handing the model an empty diff.
  let body = kept.map((c) => c.text).join('\n');
  let truncated = false;

  if (body.length > maxChars) {
    truncated = true;
    body = `${body.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters — later files in this PR are not shown]`;
  }

  const notes: string[] = [];
  if (filteredFiles.length > 0) {
    const byKind = new Map<string, string[]>();
    for (const f of filteredFiles) {
      byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.path]);
    }
    const parts = [...byKind.entries()].map(([kind, paths]) => `${paths.length} ${kind} file(s) (${paths.join(', ')})`);
    notes.push(
      `NOTE: ${parts.join('; ')} were changed in this PR but their contents are omitted here as ` +
        `they are high-volume and carry no API-surface signal. Treat them as "changed, contents not shown" — ` +
        `a PR whose ONLY changes are these files has no source change and is not documentation-relevant.`,
    );
  }
  if (kept.length === 0 && filteredFiles.length > 0) {
    notes.push('NOTE: after omission, NO source-file changes remain in this diff.');
  }

  return {
    diff: body,
    omissionNote: notes.length > 0 ? notes.join('\n') : null,
    filteredFiles,
    truncated,
    originalChars,
  };
}
