/**
 * M2 classifier evaluation harness.
 *
 * Assumptions:
 * - Diffs are fetched fresh from GitHub and cached under `.cache/diffs/` so repeated
 *   tuning runs don't re-hit the API. Delete that directory to force a refetch.
 * - Diff preparation (noise filtering + truncation) is NOT done here. It lives in
 *   `lib/diff.ts` and is applied inside `classifyDiff()`, so this harness and the production
 *   pipeline classify byte-identical input. That equivalence is what makes the gate number
 *   below predictive of production rather than an artifact of the harness.
 * - Precision here is measured on the classifier's *positive* calls, which is the metric
 *   PROJECT_BRIEF.md's M2 exit gate is written against (>=80%).
 *
 * Usage:
 *   npm run eval -- corpus/heldout-prs.json [--model claude-opus-4-8] [--concurrency 4]
 *   npm run eval -- corpus/labeled-prs.json --tag dev-baseline
 */
import { config as loadEnv } from 'dotenv';
// `.env.local` holds the real test credentials and takes precedence; `.env` is the
// committed-shape fallback. Neither is tracked (see .gitignore).
loadEnv({ path: ['.env.local', '.env'], quiet: true });
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CACHE_DIR = '.cache/diffs';

interface CorpusEntry {
  repo: string;
  pr_number: number;
  url: string;
  title: string;
  label: 'docs-relevant' | 'not-relevant';
  rationale: string;
}

interface EvalRow {
  repo: string;
  pr: number;
  url: string;
  title: string;
  expected: boolean;
  /** The model's raw verdict, BEFORE the confidence threshold. Needed to sweep thresholds
   *  offline — note `confidence` is confidence in the verdict itself, so a confident "not
   *  relevant" also scores high and must never be mixed into a threshold sweep. */
  model_relevant: boolean;
  /** What production would actually do: relevant AND confident enough to open a PR. */
  predicted: boolean;
  outcome: 'TP' | 'FP' | 'TN' | 'FN';
  confidence: number;
  model_rationale: string;
  label_rationale: string;
  diff_truncated: boolean;
  diff_chars: { original: number; sent: number };
  filtered_files: Array<{ path: string; kind: string }>;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? 'true';
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Wilson score interval — the right interval for small-n proportions. */
function wilson(successes: number, total: number, z = 1.96): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: (centre - margin) / denom, high: (centre + margin) / denom };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a GitHub token for the eval run.
 *
 * Unauthenticated GitHub API access is capped at 60 requests/hour, and getMergedPR() spends
 * 2 calls per PR — so an unauthenticated run silently dies ~26 PRs in with 403s that look
 * like rate limiting rather than like missing auth. Fail loudly instead.
 *
 * The `gh auth token` fallback lives here in the test harness on purpose: production code
 * (lib/github.ts) must not depend on a CLI being installed. This only sets the env var that
 * lib/github.ts already reads.
 */
function resolveGitHubToken(): { token: string; source: string } {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: '.env.local/.env' };
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    // gh not installed or not authenticated — fall through to the error below.
  }
  throw new Error(
    'No GitHub token available. Unauthenticated runs hit GitHub\'s 60 req/hour cap after ~26 PRs.\n' +
      'Fix: set GITHUB_TOKEN in .env.local, or run `gh auth login` so `gh auth token` resolves.',
  );
}

/**
 * GitHub returns 403 (not 429) for secondary rate limits, which concurrent diff fetching
 * trips easily. Retry with exponential backoff; the on-disk cache means a resumed run only
 * refetches what actually failed.
 */
async function loadDiff(repo: string, prNumber: number): Promise<{ title: string; body: string; diff: string }> {
  const cacheFile = path.join(CACHE_DIR, `${repo.replace('/', '__')}__${prNumber}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(await readFile(cacheFile, 'utf-8'));
  }
  const [owner, name] = repo.split('/') as [string, string];
  const { getMergedPR } = await import('../lib/github.js');

  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const pr = await getMergedPR({ owner, repo: name }, prNumber);
      const payload = { title: pr.title, body: pr.body, diff: pr.diff };
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(payload), 'utf-8');
      return payload;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status !== 403 && status !== 429 && status !== 502) throw err;

      // Distinguish "slow down for a moment" from "your hourly quota is gone". Retrying the
      // latter just burns wall-clock time at zero CPU until every attempt is exhausted.
      const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers ?? {};
      const remaining = Number(headers['x-ratelimit-remaining'] ?? '1');
      if (remaining === 0) {
        const resetAt = new Date(Number(headers['x-ratelimit-reset'] ?? '0') * 1000);
        throw new Error(
          `GitHub rate limit exhausted (limit=${headers['x-ratelimit-limit'] ?? '?'}, resets ${resetAt.toISOString()}). ` +
            'A limit of 60 means the requests were unauthenticated — check GITHUB_TOKEN.',
        );
      }
      await sleep(2000 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastErr;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const corpusPath = positional[0];
  if (!corpusPath) {
    console.error('Usage: npm run eval -- <corpus.json> [--model M] [--concurrency N] [--tag NAME]');
    process.exit(1);
  }
  if (flags.model) process.env.ANTHROPIC_MODEL = flags.model;
  const auth = resolveGitHubToken();
  process.env.GITHUB_TOKEN = auth.token;
  const concurrency = Number(flags.concurrency ?? 4);
  const tag = flags.tag ?? path.basename(corpusPath, '.json');

  // Imported AFTER the model override above — lib/ai.ts reads ANTHROPIC_MODEL at module load.
  // `shouldActOnClassification` is the SAME predicate the pipeline uses to decide whether to open
  // a PR, so precision below measures what maintainers would actually receive, not a raw verdict.
  const { classifyDiff, shouldActOnClassification, MIN_CONFIDENCE_TO_OPEN_PR } = await import('../lib/ai.js');
  console.error(`[eval] acting threshold: confidence >= ${MIN_CONFIDENCE_TO_OPEN_PR}`);

  let entries: CorpusEntry[] = JSON.parse(await readFile(corpusPath, 'utf-8'));
  // --only 7234,5900 — re-run specific PRs for targeted debugging without paying for a full pass.
  if (flags.only) {
    const wanted = new Set(flags.only.split(',').map((s) => Number(s.trim())));
    entries = entries.filter((e) => wanted.has(e.pr_number));
  }
  const rows: EvalRow[] = [];
  const failures: Array<{ repo: string; pr: number; error: string }> = [];
  let cacheReads = 0;
  let cacheCreations = 0;
  // Track full token usage, not just cache. Without input/output totals a run's cost is
  // invisible until the bill arrives — which is how the M2 tuning pass reached ~$10 unnoticed.
  let inputTokens = 0;
  let outputTokens = 0;
  let apiCalls = 0;

  console.error(
    `[eval] ${entries.length} entries · model=${process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5'} · concurrency=${concurrency} · github auth via ${auth.source}`,
  );

  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++]!;
      try {
        const pr = await loadDiff(entry.repo, entry.pr_number);
        const { result, usage, prep } = await classifyDiff({
          prTitle: pr.title,
          prBody: pr.body,
          diff: pr.diff,
        });
        cacheReads += usage.cache_read_input_tokens ?? 0;
        cacheCreations += usage.cache_creation_input_tokens ?? 0;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        if ((usage.input_tokens ?? 0) > 0) apiCalls++; // docs-only short-circuits spend nothing

        const expected = entry.label === 'docs-relevant';
        const predicted = shouldActOnClassification(result);
        rows.push({
          repo: entry.repo,
          pr: entry.pr_number,
          url: entry.url,
          title: entry.title,
          expected,
          model_relevant: result.relevant === true,
          predicted,
          outcome: predicted ? (expected ? 'TP' : 'FP') : expected ? 'FN' : 'TN',
          confidence: result.confidence,
          model_rationale: result.rationale,
          label_rationale: entry.rationale,
          diff_truncated: prep.truncated,
          diff_chars: { original: prep.originalChars, sent: prep.diff.length },
          filtered_files: prep.filteredFiles,
        });
        process.stderr.write(predicted === expected ? '.' : 'X');
      } catch (err) {
        // A failed classification is NOT a negative prediction. It must never be scored as one —
        // that silently converts API errors into false negatives and flatters recall.
        failures.push({ repo: entry.repo, pr: entry.pr_number, error: err instanceof Error ? err.message : String(err) });
        process.stderr.write('!');
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write('\n');

  const count = (o: EvalRow['outcome']) => rows.filter((r) => r.outcome === o).length;
  const tp = count('TP');
  const fp = count('FP');
  const tn = count('TN');
  const fn = count('FN');

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const pCI = wilson(tp, tp + fp);
  const rCI = wilson(tp, tp + fn);

  const report = {
    tag,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    corpus: corpusPath,
    n: rows.length,
    confusion: { tp, fp, tn, fn },
    precision: { value: precision, ci95: pCI, denominator: tp + fp },
    recall: { value: recall, ci95: rCI, denominator: tp + fn },
    f1,
    accuracy: rows.length === 0 ? 0 : (tp + tn) / rows.length,
    gate: { bar: 0.8, metric: 'precision', passed: precision >= 0.8, ci_lower_clears_bar: pCI.low >= 0.8 },
    usage: {
      api_calls: apiCalls,
      short_circuited: rows.length - apiCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReads,
      cache_creation_input_tokens: cacheCreations,
    },
    /**
     * Offline threshold sweep, computed ONLY over rows the model called relevant — mixing in
     * confident "not relevant" verdicts would be meaningless, since confidence describes the
     * verdict, not the likelihood of relevance.
     */
    threshold_sweep: [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((t) => {
      const flagged = rows.filter((r) => r.model_relevant && r.confidence >= t);
      const tp2 = flagged.filter((r) => r.expected).length;
      const fp2 = flagged.length - tp2;
      const totalPositives = rows.filter((r) => r.expected).length;
      return {
        threshold: t,
        flagged: flagged.length,
        precision: flagged.length === 0 ? null : tp2 / flagged.length,
        recall: totalPositives === 0 ? null : tp2 / totalPositives,
        tp: tp2,
        fp: fp2,
      };
    }),
    false_positives: rows.filter((r) => r.outcome === 'FP'),
    false_negatives: rows.filter((r) => r.outcome === 'FN'),
    rows,
    failures,
  };

  await mkdir('eval-results', { recursive: true });
  const outPath = `eval-results/${tag}-${report.model}.json`;
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');

  if (failures.length > 0) {
    console.error(`\n!! ${failures.length} entries FAILED and are excluded from all metrics below:`);
    for (const f of failures) console.error(`   ${f.repo}#${f.pr}: ${f.error}`);
    console.error('   Metrics computed on the remainder are not comparable to a full run.');
  }

  console.error(`
=== ${tag} · ${report.model} · n=${rows.length} ===
  TP ${tp}   FP ${fp}   TN ${tn}   FN ${fn}${failures.length ? `   (${failures.length} fetch/API failures)` : ''}
  Precision  ${pct(precision)}  [95% CI ${pct(pCI.low)}–${pct(pCI.high)}]  on ${tp + fp} positive calls
  Recall     ${pct(recall)}  [95% CI ${pct(rCI.low)}–${pct(rCI.high)}]
  F1         ${pct(f1)}       Accuracy ${pct(report.accuracy)}
  Gate (precision >= 80%): ${report.gate.passed ? 'MET on point estimate' : 'NOT MET'}${report.gate.ci_lower_clears_bar ? ' · CI lower bound also clears' : ' · CI lower bound does NOT clear'}
  Tokens: ${inputTokens} in / ${outputTokens} out · cache ${cacheReads} read / ${cacheCreations} creation
  API calls: ${apiCalls} (${rows.length - apiCalls} decided without an API call)
  Written to ${outPath}
`);

  if (fp > 0) {
    console.error('False positives (the failure that costs installs):');
    for (const r of report.false_positives) console.error(`  ${r.repo}#${r.pr} (conf ${r.confidence}) — ${r.title}\n    model: ${r.model_rationale}`);
  }
  if (fn > 0) {
    console.error('\nFalse negatives (missed drift):');
    for (const r of report.false_negatives) console.error(`  ${r.repo}#${r.pr} (conf ${r.confidence}) — ${r.title}\n    model: ${r.model_rationale}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
