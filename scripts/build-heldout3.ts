/**
 * Stage 3: assemble the final M2 gate corpus from
 *   - hand labels (corpus/_hand-labels.json), excluding anything marked `contested`
 *   - the file-path-certain negatives found during triage (corpus/_candidates.json)
 *
 * Contested entries are dropped: a label I cannot defend is worse than a smaller corpus,
 * because it silently moves the gate number in a direction nobody can audit.
 */
import { readFile, writeFile } from 'node:fs/promises';

interface Hand { repo: string; pr: number; label: string; conf: string; contested?: boolean; why: string }
interface Cand {
  repo: string; pr_number: number; url: string; title: string;
  auto_label?: string; auto_reason?: string; maintainer_documented: boolean;
}

const hand: Hand[] = JSON.parse(await readFile('corpus/_hand-labels.json', 'utf-8'));
const cands: Cand[] = JSON.parse(await readFile('corpus/_candidates.json', 'utf-8'));
const byKey = new Map(cands.map((c) => [`${c.repo}#${c.pr_number}`, c]));

const out: Array<Record<string, unknown>> = [];
const dropped: string[] = [];

for (const h of hand) {
  const key = `${h.repo}#${h.pr}`;
  if (h.contested) { dropped.push(key); continue; }
  const c = byKey.get(key);
  if (!c) { console.error(`  ! no candidate record for ${key}`); continue; }
  out.push({
    repo: h.repo, pr_number: h.pr, url: c.url, title: c.title,
    label: h.label, rationale: h.why,
    label_source: 'hand-read-diff', label_confidence: h.conf,
    maintainer_documented: c.maintainer_documented,
  });
}

for (const c of cands) {
  if (!c.auto_label) continue;
  if (byKey.has(`${c.repo}#${c.pr_number}`) && hand.some((h) => h.repo === c.repo && h.pr === c.pr_number)) continue;
  out.push({
    repo: c.repo, pr_number: c.pr_number, url: c.url, title: c.title,
    label: c.auto_label, rationale: c.auto_reason,
    label_source: 'file-paths-certain', label_confidence: 'high',
    maintainer_documented: c.maintainer_documented,
  });
}

await writeFile('corpus/heldout3-prs.json', JSON.stringify(out, null, 2), 'utf-8');

const pos = out.filter((e) => e.label === 'docs-relevant').length;
const byRepo = new Map<string, number>();
for (const e of out) byRepo.set(e.repo as string, (byRepo.get(e.repo as string) ?? 0) + 1);
console.error(`corpus/heldout3-prs.json — ${out.length} entries`);
console.error(`  ${pos} docs-relevant / ${out.length - pos} not-relevant (${Math.round((pos / out.length) * 100)}% positive)`);
console.error(`  ${dropped.length} contested entries excluded: ${dropped.join(', ')}`);
console.error(`  repos: ${[...byRepo.entries()].map(([r, n]) => `${r.split('/')[1]}=${n}`).join(' ')}`);
