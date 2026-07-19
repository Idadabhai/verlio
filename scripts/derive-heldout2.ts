/**
 * Build a gate corpus whose labels come from MAINTAINER BEHAVIOUR, not from my judgment.
 *
 * Ground-truth rule: a PR is docs-relevant iff the maintainers themselves touched documentation
 * (docs, README, changelog, or a changeset release note) in the same PR as a source change.
 * They are the domain experts on their own project; using their action removes the labeler's
 * subjectivity on exactly the cases where it is least reliable (framework-internals fixes that
 * are defensible either way).
 *
 * LEAKAGE CONTROL — the reason this file records `classify_diff_excludes_docs`:
 * the label is derived from the presence of doc files, so if the classifier were shown those
 * files it could score well by pattern-matching `.changeset/` or `docs/` paths without any
 * semantic judgment. The eval therefore strips doc files from the diff before classification
 * (see --strip-docs in eval-classifier.ts). The classifier sees ONLY the source change and must
 * predict what the maintainer did. That is the real product question and it is strictly harder.
 *
 * KNOWN BIAS, stated up front: this rule labels a genuine API change `not-relevant` when the
 * maintainer forgot to document it. Such cases become false positives, so the bias pushes
 * measured precision DOWN, never up. A gate passed under this rule is passed conservatively.
 *
 * Excluded from the corpus:
 *  - docs-only PRs (no source change) — `isDocsOnlyDiff` decides those deterministically without
 *    an API call, so testing the model on them measures nothing.
 *  - PRs with no files, or that fail to fetch.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'], quiet: true });
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

/** Documentation the maintainer writes by hand — presence alongside source ⇒ docs-relevant. */
const DOC_SIGNAL = /\.(md|mdx|markdown|rst)$|^(docs?|documentation|website|site)\/|(^|\/)(README|CHANGELOG|HISTORY|MIGRATING|UPGRADING)(\.[a-z]+)?$/i;
/** Never counted as either doc signal or source: repo plumbing with no user-facing surface. */
const IGNORED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum)$|^\.github\/|^\.changeset\/config\.json$|(^|\/)__snapshots__\/|\.snap$/i;

const REPOS = [
  'sveltejs/svelte',
  'vuejs/core',
  'pinojs/pino',
  'trpc/trpc',
  'withastro/astro',
  'nestjs/nest',
  'remix-run/react-router',
  'sequelize/sequelize',
];
const PER_REPO = 25;

const gh = (args: string[]) => execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

interface Entry {
  repo: string;
  pr_number: number;
  url: string;
  title: string;
  label: 'docs-relevant' | 'not-relevant';
  rationale: string;
  doc_files: string[];
  source_files: string[];
  label_source: 'maintainer-behaviour';
  classify_diff_excludes_docs: true;
}

const out: Entry[] = [];
const skipped: Array<{ repo: string; pr: number; why: string }> = [];

for (const repo of REPOS) {
  let list: Array<{ number: number; title: string; url: string }>;
  try {
    list = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(PER_REPO), '--json', 'number,title,url']));
  } catch (err) {
    console.error(`  ! ${repo}: could not list PRs — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  for (const pr of list) {
    let files: string[];
    try {
      files = gh(['pr', 'diff', '--repo', repo, String(pr.number), '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      skipped.push({ repo, pr: pr.number, why: 'diff fetch failed' });
      continue;
    }

    const considered = files.filter((f) => !IGNORED.test(f));
    const docFiles = considered.filter((f) => DOC_SIGNAL.test(f));
    const sourceFiles = considered.filter((f) => !DOC_SIGNAL.test(f));

    if (sourceFiles.length === 0) {
      skipped.push({ repo, pr: pr.number, why: 'docs-only or ignored-only — decided deterministically, not a model test' });
      continue;
    }

    const relevant = docFiles.length > 0;
    out.push({
      repo,
      pr_number: pr.number,
      url: pr.url,
      title: pr.title,
      label: relevant ? 'docs-relevant' : 'not-relevant',
      rationale: relevant
        ? `Maintainers documented this change in the same PR (${docFiles.join(', ')}) alongside ${sourceFiles.length} source file(s). Their action is the ground truth.`
        : `Maintainers changed ${sourceFiles.length} source file(s) and wrote no documentation or changelog entry, indicating they did not consider it user-facing.`,
      doc_files: docFiles,
      source_files: sourceFiles,
      label_source: 'maintainer-behaviour',
      classify_diff_excludes_docs: true,
    });
    process.stderr.write(relevant ? 'R' : '.');
  }
  process.stderr.write(` [${repo}]\n`);
}

const pos = out.filter((e) => e.label === 'docs-relevant').length;
await writeFile('corpus/heldout2-prs.json', JSON.stringify(out, null, 2), 'utf-8');
console.error(`\n${out.length} entries → corpus/heldout2-prs.json`);
console.error(`  ${pos} docs-relevant / ${out.length - pos} not-relevant (${((pos / out.length) * 100).toFixed(0)}% positive)`);
console.error(`  ${skipped.length} skipped (${skipped.filter((s) => s.why.startsWith('docs-only')).length} docs-only)`);
