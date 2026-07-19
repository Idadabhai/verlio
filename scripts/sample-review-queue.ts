/**
 * Stage 1b: pick which of the 166 review-needed candidates I will actually hand-read.
 *
 * Sampling is stratified BY REPO and, within each repo, interleaves PRs the maintainer
 * documented in-PR with ones they did not. That interleaving matters: sampling preferentially
 * from documented PRs would load the corpus with likely-positives and inflate precision, since
 * precision falls as more negatives become available to be false-positived.
 *
 * Deterministic (no RNG) so the queue is reproducible and the selection can be audited.
 */
import { readFile, writeFile } from 'node:fs/promises';

const TARGET = 88;

interface Candidate {
  repo: string;
  pr_number: number;
  title: string;
  url: string;
  source_files: string[];
  doc_files: string[];
  maintainer_documented: boolean;
  auto_label?: string;
  label?: string;
}

const all: Candidate[] = JSON.parse(await readFile('corpus/_candidates.json', 'utf-8'));
const review = all.filter((c) => !c.auto_label);

const byRepo = new Map<string, Candidate[]>();
for (const c of review) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c]);

// Within each repo, alternate documented / undocumented so both classes are represented evenly.
const queues = [...byRepo.entries()].map(([repo, list]) => {
  const doc = list.filter((c) => c.maintainer_documented);
  const undoc = list.filter((c) => !c.maintainer_documented);
  const woven: Candidate[] = [];
  for (let i = 0; i < Math.max(doc.length, undoc.length); i++) {
    if (doc[i]) woven.push(doc[i]!);
    if (undoc[i]) woven.push(undoc[i]!);
  }
  return { repo, woven };
});

// Round-robin across repos so no single project dominates the sample.
const picked: Candidate[] = [];
for (let i = 0; picked.length < TARGET; i++) {
  let progressed = false;
  for (const q of queues) {
    if (q.woven[i]) {
      picked.push(q.woven[i]!);
      progressed = true;
      if (picked.length >= TARGET) break;
    }
  }
  if (!progressed) break;
}

await writeFile('corpus/_review-queue.json', JSON.stringify(picked, null, 2), 'utf-8');

const docd = picked.filter((c) => c.maintainer_documented).length;
console.error(`${picked.length} PRs queued for hand-reading → corpus/_review-queue.json`);
console.error(`  ${docd} documented in-PR / ${picked.length - docd} not — a rough upper/lower bracket on the positive rate`);
for (const [repo, list] of byRepo) {
  console.error(`  ${repo}: ${picked.filter((p) => p.repo === repo).length} of ${list.length}`);
}
