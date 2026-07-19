import Anthropic from '@anthropic-ai/sdk';
import { isCommentOnlyDiff, isDocsOnlyDiff, prepareDiff } from './diff.js';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

// Frozen persona/instructions block — never interpolate per-call data (diff, PR title,
// timestamps) into this string, or the cache_control breakpoint below stops hitting.
// Kept deliberately detailed (well past the ~1-4K token minimum cacheable prefix for
// Sonnet-tier models) so cache_control actually produces cache hits rather than silently
// no-opping on a too-short prefix — see verlio_CHANGELOG.md for the measured numbers.
const CLASSIFY_SYSTEM_PROMPT = `You are Verlio's documentation-drift classifier. You are shown a
merged pull request's code diff and decide whether the change is documentation-relevant: would a
maintainer need to update public-facing docs (README, API reference, usage guides, changelog)
because of this change?

## STEP 0 — precondition. Check this FIRST, before any other rule below.
Does this diff change at least one non-documentation source file?

Scan the file paths in the diff. If EVERY changed file is documentation or markdown (\`.md\`,
\`.mdx\`, \`docs/\`, \`README\`, \`CHANGELOG\`, \`CONTRIBUTING\`, a docs-site config), then answer
**relevant: false** immediately and stop. A human already wrote that documentation by hand;
there is no code change for this tool to react to, and opening a PR against it is pure noise.

This precondition OVERRIDES every other rule in this prompt, including the guidance below about
in-PR documentation edits being confirming evidence. That guidance applies ONLY when source code
also changed in the same diff. A docs-only diff is always relevant: false, at high confidence, no
exceptions.

Your \`relevant\` boolean MUST agree with your \`rationale\`. If you find yourself writing a
rationale that concludes "there is no source change here" or "nothing for this tool to react to",
the boolean is false. Never emit a rationale arguing one verdict and a boolean asserting the other.

## STEP 1 — name the surface, and let that calibrate your confidence
Try to name the SPECIFIC documented surface whose description is now wrong, incomplete, or
missing: a named option, method, event, CLI flag, exported type or constant, config key, or
error/status code. Put whatever you find in \`doc_signals\`.

This is a CONFIDENCE calibration, not a hard gate. If you can name the surface plainly
(\`the \`retryLimit\` option was ignored when set to 0\`, \`the \`onClose\` event never fired on the
secure server variant\`, \`adds the \`--strict-ports\` flag\`), be confident. If the most honest
description is "some internal thing was wrong and is now right" — an internal crash, a leak, a
stale reference, generated code that was malformed, a reverted performance heuristic — and you
cannot point at a documented surface, then you are NOT confident: report a low confidence, and
lean false.

Report confidence honestly and use the full range. Downstream, Verlio only opens a pull request
above a confidence threshold, so an accurate low score is genuinely useful — it is not a failure
to be unsure, and inflating confidence to seem decisive directly causes the noisy PRs that get
this tool uninstalled. A well-calibrated 0.5 is worth more than a confident guess.

## STEP 1b — comment-only changes are never relevant
If the only edits to source files are inside comments, JSDoc blocks, docstrings, or type-level
annotations that add no new type — corrected prose, added \`@param\`/\`@public\`/\`@category\` tags,
reworded examples, added backticks, fixed a wrong \`@default\` note — then no behaviour changed and
the answer is **relevant: false**, regardless of how many files were touched or how documentation-
flavoured the PR title is. A comment is not code.

## The exact question you are answering (read this once steps 0 and 1 pass)
You are the FIRST of two stages. Your question is: **"is there a real change here that a
maintainer would need to describe to users somewhere?"** You are NOT deciding whether any
particular documentation file needs an edit — a second stage (the drafter) is shown the actual
doc files and decides that, and it can and does correctly conclude "the existing docs already
cover this, no edit needed."

Two consequences, both of which are common mistakes:

1. **Do not answer "not relevant" on the grounds that the docs are already correct.** Reasoning
   of the form "this fix makes the behavior match what the docs already say, so no docs update is
   warranted" is the drafter's judgment, not yours. If a documented feature was observably
   broken for a valid input and now works, that is a real user-facing change — answer relevant
   and let the drafter decide whether any file actually needs editing. A user who read the docs,
   hit the bug, and worked around it needs to know it was fixed.

2. **Do not answer "not relevant" because the PR already updated its own docs or changelog.**
   (This rule presupposes step 0 passed — i.e. source code changed too. It never applies to a
   docs-only diff.) Given a real source change, a maintainer editing a doc, changelog, or
   migration note inside the same diff is CONFIRMING evidence that the change is
   documentation-relevant — they judged it worth describing. Other docs (README, API reference,
   guides) may still be stale even when the changelog was updated. So an in-PR doc edit
   alongside a code change is evidence FOR relevant, never against.

## What counts as docs-relevant
- A new, removed, or renamed public API endpoint, function, class, exported type, CLI flag, or
  config option.
- A changed request/response shape, parameter, or return value on a documented function.
- A changed default value, accepted input format, or validation rule for a documented option.
- A behavior fix that changes what a documented feature actually does — including a "refactor" or
  "dependency bump" PR that, on inspection of the diff, also changes documented behavior. Read
  the diff itself, not just the PR title; titles frequently undersell or mislabel the change.
- A documented feature that was silently broken for a valid input and now behaves correctly —
  e.g. an option whose value was dropped by a falsy check, a validator that rejected input it
  documents as valid, a guard that could be bypassed. Confidence here should track STEP 1: high
  when you can name the documented option/method/event, low when the honest summary is "some
  internal function was wrong and is now right", however real the bug was.
- A security fix that changes how a documented API handles a class of input (e.g. prototype
  pollution, injection) — these warrant a docs/changelog note even if the "happy path" behavior
  is unchanged.
- A new documented error/status code, exit code, or event type.

## What does NOT count as docs-relevant
- Internal refactors with no change to any public surface (e.g. extracting a private helper,
  renaming an internal variable, restructuring internal control flow) — even when the PR title
  says "fix" or "refactor", if the observable behavior of every public function is identical,
  it is not relevant.
- Test-only changes (new test cases for existing, unchanged behavior) with no source file touched.
- CI/build/tooling config (GitHub Actions version pins, dependabot config, lockfile-only
  dependency bumps with no accompanying behavior change).
- Formatting/lint-only changes, comment or JSDoc-comment typo fixes, changed inline example
  wording that doesn't reflect a code behavior change.
- A diff that is itself only markdown/docs files with zero source code changed — there is nothing
  for this tool to react to; a human already wrote the doc change directly.

## Worked examples (from real merged PRs — titles can mislead, always check the diff)
- "refactor(helpers): extract duplicated setFormDataHeaders into a shared helper" — relevant:
  true. The "refactor" also silently fixed a bug (tolerating a FormData implementation that
  returns no headers under a documented config option), changing real behavior.
- "Upgrade \`content-type\` to ^2.0.0" — relevant: true. Framed as a dependency bump, but it
  changed a documented function's output (existing Content-Type parameters are now preserved
  instead of being dropped).
- "fix(deps): update octokit monorepo (major)" — relevant: false. Pure package-lock.json version
  bumps with no source file touched in this repo; nothing here changed observable behavior.
- "docs: fix some minor docs inconsistencies" — relevant: false. The diff only edits JSDoc
  comment text (a typo, a corrected example), not any function's implementation.
- "fix(v4): skip __proto__ key in object catchall" — relevant: true. A security fix changing how
  a documented schema method (\`.passthrough()\`) handles a specific input shape.
- "chore: prune stale advisory refs" — relevant: false. Only updates URLs inside source comments
  and test names; no functional code changed.

Bias toward precision over recall: a wrongly-flagged PR erodes trust in this tool far more than a
missed one (one bad auto-generated PR undoes many good ones). When genuinely unsure after reading
the diff, prefer relevant: false.

Apply that tiebreak to the right question, though. It resolves genuine uncertainty about **whether
this diff changes anything users can observe** — e.g. you cannot tell from the diff whether a
touched symbol is public or internal. It does NOT license answering false because you doubt any
doc file needs editing, or because the change seems small, niche, or already-documented-in-intent.
Those are the drafter's call (rules 1 and 2 at the top). Uncertain that the behavior changed at
all → false. Confident the behavior changed but unsure whether docs need an edit → true.

Call submit_classification exactly once with your verdict.`;

const DRAFT_SYSTEM_PROMPT = `You are Verlio's documentation drafter. You are shown a merged pull
request's code diff (already judged documentation-relevant by an upstream classifier) plus the
current content of candidate documentation files from the same repo. Decide which of those files
(if any) need an update, and write the complete new content for each file you'd change.

## Ground rules
- Keep changes minimal and surgical — edit only the sections the diff actually affects. Do not
  rewrite, reorganize, or "improve" unrelated parts of the file.
- Preserve the file's existing tone, heading structure, and markdown formatting conventions
  (code fence language tags, table layout, list style) exactly as they already appear.
- Do not invent details the diff doesn't support. If the diff doesn't tell you the new default
  value, error message, or exact option name, don't guess — omit that detail rather than
  fabricating it.
- If none of the candidate files reference the changed behavior at all, or the existing docs
  already accurately describe the new behavior without needing an edit, set should_draft to
  false and leave edits empty rather than forcing a cosmetic edit to justify the classifier's
  relevant:true verdict. Not every docs-relevant diff has a corresponding doc file among the
  candidates you were given — the classifier and the drafter answer different questions.
- When a change is additive (a new option, a new exported constant), prefer adding a new
  paragraph, list item, or table row near the existing similar entries over restructuring the
  section. When a change is corrective (a previously-wrong default, a previously-undocumented
  edge case), edit the specific sentence that is now stale.
- Never fabricate a docs page that doesn't exist in the candidate list — only propose edits to
  files you were actually given.

## Output
Write a concise summary suitable for a PR description: what changed in the code, and what you
changed in the docs (or why nothing needed to change). Call submit_draft exactly once.`;

export interface ClassificationResult {
  relevant: boolean;
  confidence: number;
  rationale: string;
  doc_signals: string[];
}

export interface DraftEdit {
  path: string;
  new_content: string;
  rationale: string;
}

export interface DraftResult {
  should_draft: boolean;
  edits: DraftEdit[];
  summary: string;
}

interface DiffInput {
  prTitle: string;
  prBody: string;
  diff: string;
}

/**
 * Builds the user turn. Both call sites go through this so the classifier and the drafter
 * (and the M2 eval harness, which calls classifyDiff) see identically-prepared diffs.
 * Raw diffs are never sent: see lib/diff.ts for why unbounded diffs break this pipeline.
 */
function buildDiffContent(input: DiffInput): { content: string; prep: ReturnType<typeof prepareDiff> } {
  const prep = prepareDiff(input.diff);
  const content = [
    `PR title: ${input.prTitle}`,
    '',
    `PR body:\n${input.prBody || '(none)'}`,
    '',
    ...(prep.omissionNote ? [prep.omissionNote, ''] : []),
    `Diff:\n${prep.diff || '(no source-file changes)'}`,
  ].join('\n');
  return { content, prep };
}

export type DiffPrepInfo = ReturnType<typeof prepareDiff>;

/**
 * Extract and VALIDATE a forced tool-use result.
 *
 * The naive version of this (`return block.input as T`) is dangerous: when a response is cut
 * off at max_tokens mid-tool-call, the SDK still surfaces a tool_use block whose `input` is a
 * partial object. Casting that to ClassificationResult yields `relevant: undefined`, which is
 * falsy — so a truncated, never-actually-made judgment silently becomes "not docs-relevant"
 * and the pipeline skips a PR it never classified. It fails closed and silent, which is the
 * worst combination. Validate the required keys and fail loudly instead.
 */
function extractToolInput<T>(response: Anthropic.Message, toolName: string, requiredKeys: ReadonlyArray<keyof T & string>): T {
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === toolName,
  );
  if (!block) {
    throw new Error(`Expected ${toolName} tool_use block, got stop_reason=${response.stop_reason}`);
  }
  const input = block.input as Record<string, unknown>;
  const missing = requiredKeys.filter((k) => input?.[k] === undefined);
  if (missing.length > 0) {
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use').length;
    throw new Error(
      `${toolName} returned incomplete input (missing: ${missing.join(', ')}); ` +
        `stop_reason=${response.stop_reason}, output_tokens=${response.usage.output_tokens}, ` +
        `tool_use_blocks=${toolBlocks}, received_keys=[${Object.keys(input ?? {}).join(', ')}], ` +
        `block_types=[${response.content.map((b) => b.type).join(', ')}]. ` +
        (response.stop_reason === 'max_tokens'
          ? 'The response was truncated — raise max_tokens.'
          : 'Unexpected partial tool call.'),
    );
  }
  return input as T;
}

/**
 * A `relevant: true` verdict carrying sub-50% confidence is self-contradictory: the model is
 * asserting drift while simultaneously reporting it does not believe its own assertion. Observed
 * in the M2 tuning pass on lodash#6181, where the rationale argued *against* relevance ("only
 * version metadata changed here") while the boolean came back true at confidence 0.016.
 *
 * This is a coherence guard, not a tuned threshold — 0.5 is the "more likely than not" boundary,
 * which is where a positive claim stops being self-consistent, independent of any corpus.
 */
const MIN_COHERENT_POSITIVE_CONFIDENCE = 0.5;

/**
 * Verlio only opens a pull request when the classifier is confident, not merely when it leans
 * positive. This is the main precision control and it exists because the two failure modes are
 * not symmetric: a missed doc update is invisible, while a wrong PR lands in a maintainer's inbox
 * and costs trust (Nevo David's "one bad screenshot undoes fifty installs").
 *
 * Measured during M2: correct positive calls clustered around 0.85 confidence, incorrect ones
 * around 0.70 — the model does know when it is guessing, we simply were not acting on it.
 *
 * TUNED ON `corpus/heldout3-TUNE.json` ONLY and then validated once on the sealed half. Never
 * re-tune this against the sealed corpus or against production data you have already scored —
 * that silently converts the gate into a self-graded exam.
 *
 * Chosen from the sweep on the TUNE half (13 positives, 18 flagged), committed BEFORE running
 * the sealed half:
 *   t=0.50 → precision 84.6%, recall 84.6%
 *   t=0.55 → precision 80.0%, recall 61.5%   (non-monotonic — small-sample noise)
 *   t=0.60 → precision 87.5%, recall 53.8%   ← chosen
 *   t=0.65 → precision 100%,  recall 46.2%   (clearly overfit at n=6)
 *
 * 0.60 over the higher-recall 0.50 deliberately: PROJECT_BRIEF.md and the council are explicit
 * that a wrong PR costs far more than a missed one, and the wobble between 0.50 and 0.55 shows
 * this sample cannot distinguish those two points reliably. 0.65+ is overfitting to six examples.
 * The recall cost is real and documented — roughly half of genuine drift stays unreported at
 * launch. Raising recall is a prompt problem to solve later, not a reason to lower this now.
 */
export const MIN_CONFIDENCE_TO_OPEN_PR = Number(process.env.VERLIO_MIN_CONFIDENCE ?? 0.6);

/**
 * The verdict the pipeline should act on: relevant AND confident enough to be worth a
 * maintainer's attention. Exported so the eval harness scores exactly what production does.
 */
export function shouldActOnClassification(r: ClassificationResult): boolean {
  return r.relevant === true && (r.confidence ?? 0) >= MIN_CONFIDENCE_TO_OPEN_PR;
}

/** Zero-token usage for verdicts decided without an API call. */
const EMPTY_USAGE: Anthropic.Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as Anthropic.Usage;

function isIncoherent(r: ClassificationResult): boolean {
  return r.relevant === true && typeof r.confidence === 'number' && r.confidence < MIN_COHERENT_POSITIVE_CONFIDENCE;
}

export async function classifyDiff(
  input: DiffInput,
): Promise<{ result: ClassificationResult; usage: Anthropic.Usage; prep: DiffPrepInfo }> {
  // Decide the docs-only case without an API call — see isDocsOnlyDiff for why this is
  // deterministic rather than delegated to the model.
  if (isDocsOnlyDiff(input.diff)) {
    return {
      result: {
        relevant: false,
        confidence: 1,
        rationale:
          'Every file changed in this PR is documentation; there is no source-code change for Verlio to react to.',
        doc_signals: [],
      },
      usage: EMPTY_USAGE,
      prep: prepareDiff(input.diff),
    };
  }

  // Same deterministic treatment for comment/JSDoc-only source diffs — see isCommentOnlyDiff.
  if (isCommentOnlyDiff(input.diff)) {
    return {
      result: {
        relevant: false,
        confidence: 1,
        rationale:
          'Every changed line in this diff is a comment, JSDoc annotation, or blank line — no behavior changed.',
        doc_signals: [],
      },
      usage: EMPTY_USAGE,
      prep: prepareDiff(input.diff),
    };
  }

  // Exactly one bounded retry covers both observed incoherence modes: a partial tool call
  // (missing required keys, which extractToolInput throws on) and a self-contradictory verdict.
  // Without it, an intermittent bad generation means the webhook errors and the PR is skipped.
  try {
    const first = await classifyDiffOnce(input);
    if (!isIncoherent(first.result)) return first;
    // Retry once; if the second attempt is also incoherent we return it anyway rather than
    // failing the PR outright — the low confidence is preserved for the caller to act on.
    return await classifyDiffOnce(input);
  } catch {
    // First attempt threw (truncated/partial tool call). Retry once, letting a second
    // failure propagate to the caller.
    return await classifyDiffOnce(input);
  }
}

async function classifyDiffOnce(
  input: DiffInput,
): Promise<{ result: ClassificationResult; usage: Anthropic.Usage; prep: DiffPrepInfo }> {
  const { content, prep } = buildDiffContent(input);
  const response = await getClient().messages.create({
    model: MODEL,
    // Thinking tokens count against max_tokens. At 1024 with adaptive thinking + high effort,
    // longer diffs truncated the tool call mid-JSON — see extractToolInput's note. The tool
    // output itself is small (a verdict plus a few sentences); this headroom is for reasoning.
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [
      {
        type: 'text',
        text: CLASSIFY_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'submit_classification',
        description: 'Submit the docs-relevance verdict for this diff.',
        input_schema: {
          type: 'object',
          properties: {
            relevant: { type: 'boolean', description: 'True if this diff warrants a documentation update.' },
            confidence: { type: 'number', description: 'Confidence in this verdict, 0.0 to 1.0.' },
            rationale: { type: 'string', description: 'One to three sentences explaining the verdict.' },
            doc_signals: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific code symbols/paths that drove the verdict (e.g. changed function signatures, endpoints).',
            },
          },
          required: ['relevant', 'confidence', 'rationale', 'doc_signals'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_classification' },
    messages: [{ role: 'user', content }],
  });

  const result = extractToolInput<ClassificationResult>(response, 'submit_classification', [
    'relevant',
    'confidence',
    'rationale',
    'doc_signals',
  ]);
  return { result, usage: response.usage, prep };
}

export async function draftDocUpdate(
  input: DiffInput & { candidateDocs: Array<{ path: string; content: string }> },
): Promise<{ result: DraftResult; usage: Anthropic.Usage }> {
  const docsBlock = input.candidateDocs
    .map((d) => `--- ${d.path} ---\n${d.content}`)
    .join('\n\n');
  const { content: diffContent } = buildDiffContent(input);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [
      {
        type: 'text',
        text: DRAFT_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'submit_draft',
        description: 'Submit the drafted documentation update.',
        input_schema: {
          type: 'object',
          properties: {
            should_draft: { type: 'boolean', description: 'True if at least one candidate doc file needs a change.' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  new_content: { type: 'string', description: 'The complete new file content.' },
                  rationale: { type: 'string' },
                },
                required: ['path', 'new_content', 'rationale'],
                additionalProperties: false,
              },
            },
            summary: { type: 'string', description: 'One or two sentences summarizing the change, for the PR description.' },
          },
          required: ['should_draft', 'edits', 'summary'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_draft' },
    messages: [
      {
        role: 'user',
        content: `${diffContent}\n\nCandidate documentation files:\n${docsBlock || '(none found)'}`,
      },
    ],
  });

  const result = extractToolInput<DraftResult>(response, 'submit_draft', ['should_draft', 'edits', 'summary']);
  return { result, usage: response.usage };
}
