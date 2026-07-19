/**
 * Stage 1 of building the M2 gate corpus: split candidate PRs into
 *   (a) CERTAIN — decidable from file paths alone, no judgement needed, no diff read required
 *   (b) REVIEW  — genuinely needs a human to read the diff
 *
 * This exists because reading ~200 diffs by hand is the real cost of M2, and a large share of
 * merged PRs need no judgement at all: a diff touching only a lockfile, only CI workflow files,
 * or only tests cannot change a documented public surface. Auto-resolving those is not a
 * shortcut on rigour — it is the same rule a human would apply, applied consistently.
 *
 * Anything with a source file goes to REVIEW. Nothing is auto-labeled `docs-relevant`: a
 * positive label always requires a human reading the actual diff, because that is the label the
 * precision gate is computed against and it must not be derived from a heuristic.
 *
 * Emits corpus/_candidates.json for stage 2 (hand labeling).
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'], quiet: true });
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Repos chosen for: docs kept IN-repo, and a deliberate mix of changelog conventions so the
 *  set isn't dominated by changeset-driven projects (which skew heavily positive). */
const REPOS = [
  'sveltejs/svelte',          // changesets
  'withastro/astro',          // changesets
  'remix-run/react-router',   // changelog
  'pinojs/pino',              // docs/ dir, no changesets
  'sequelize/sequelize',      // docs/ dir
  'vitest-dev/vitest',        // docs/ dir
  'rollup/rollup',            // docs/ dir
  'eslint/eslint',            // docs/ dir
  'knex/knex',                // no formal convention
  'socketio/socket.io',       // docs external-ish, mixed
];
const PER_REPO = 22;

const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock)$/i;
const CI = /^\.github\/|^\.circleci\/|(^|\/)(\.travis\.yml|azure-pipelines\.yml|netlify\.toml|vercel\.json|renovate\.json|\.editorconfig|\.gitignore|\.npmrc|\.nvmrc)$/i;
// NOTE: must be a single pattern with `|` INSIDE it. Writing `/a/i | /b/i` is a bitwise OR of
// two RegExp objects, which silently evaluates to 0 rather than matching anything.
const TEST = /(^|\/)(test|tests|__tests__|spec|e2e|cypress|playground|benchmarks?|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOC = /\.(md|mdx|markdown|rst)$|^(docs?|documentation|website|site)\/|(^|\/)(README|CHANGELOG|HISTORY|MIGRATING|UPGRADING|CONTRIBUTING|SECURITY|LICENSE)(\.[a-z]+)?$/i;
const CHANGESET = /^\.changeset\/.*\.md$/i;

const gh = (args: string[]) => execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

interface Candidate {
  repo: string;
  pr_number: number;
  url: string;
  title: string;
  files: string[];
  source_files: string[];
  doc_files: string[];
  /** Set only when the verdict needs no human judgement. */
  auto_label?: 'not-relevant';
  auto_reason?: string;
  /** Did the maintainer document it in-PR? Corroborating signal for stage 2, never the sole basis. */
  maintainer_documented: boolean;
}

const candidates: Candidate[] = [];

for (const repo of REPOS) {
  let list: Array<{ number: number; title: string; url: string }>;
  try {
    list = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(PER_REPO), '--json', 'number,title,url']));
  } catch (err) {
    console.error(`  ! ${repo}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    continue;
  }

  for (const pr of list) {
    let files: string[];
    try {
      files = gh(['pr', 'diff', '--repo', repo, String(pr.number), '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const docFiles = files.filter((f) => DOC.test(f) || CHANGESET.test(f));
    const sourceFiles = files.filter((f) => !DOC.test(f) && !CHANGESET.test(f) && !LOCKFILE.test(f) && !CI.test(f) && !TEST.test(f));

    const c: Candidate = {
      repo,
      pr_number: pr.number,
      url: pr.url,
      title: pr.title,
      files,
      source_files: sourceFiles,
      doc_files: docFiles,
      maintainer_documented: docFiles.length > 0,
    };

    // CERTAIN negatives — no source file was touched, so no documented surface can have changed.
    if (sourceFiles.length === 0) {
      if (files.every((f) => DOC.test(f) || CHANGESET.test(f))) {
        c.auto_label = 'not-relevant';
        c.auto_reason = 'Documentation-only diff: no source file changed. Decided deterministically by isDocsOnlyDiff() before any API call.';
      } else if (files.every((f) => LOCKFILE.test(f) || CI.test(f) || DOC.test(f) || CHANGESET.test(f))) {
        c.auto_label = 'not-relevant';
        c.auto_reason = 'Only lockfile/CI/config files changed; no library source touched.';
      } else if (files.every((f) => TEST.test(f) || LOCKFILE.test(f) || CI.test(f) || DOC.test(f) || CHANGESET.test(f))) {
        c.auto_label = 'not-relevant';
        c.auto_reason = 'Test-only diff: no source file changed, so no new behaviour to document.';
      }
    }
    candidates.push(c);
    process.stderr.write(c.auto_label ? '-' : '?');
  }
  process.stderr.write(` [${repo}]\n`);
}

// Preserve any labels already applied in a previous stage-2 pass.
let existing: Record<string, unknown> = {};
if (existsSync('corpus/_candidates.json')) {
  const prior = JSON.parse(await readFile('corpus/_candidates.json', 'utf-8')) as Array<Record<string, unknown>>;
  existing = Object.fromEntries(prior.filter((p) => p.label).map((p) => [`${p.repo}#${p.pr_number}`, p]));
}
const merged = candidates.map((c) => ({ ...c, ...(existing[`${c.repo}#${c.pr_number}`] ?? {}) }));

await writeFile('corpus/_candidates.json', JSON.stringify(merged, null, 2), 'utf-8');

const auto = merged.filter((c) => c.auto_label).length;
const review = merged.length - auto;
const docd = merged.filter((c) => !c.auto_label && c.maintainer_documented).length;
console.error(`\n${merged.length} candidates → corpus/_candidates.json`);
console.error(`  ${auto} auto-resolved as not-relevant (no judgement needed, no diff read)`);
console.error(`  ${review} need a human diff read — of those, ${docd} were documented in-PR by the maintainer`);
