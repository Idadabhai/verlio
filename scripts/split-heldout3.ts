/**
 * Split the 108-entry gate corpus into a TUNE half and a SEALED half.
 *
 * I have already seen the summary of the full run, so this split is a discipline rather than a
 * perfect firewall: from here on I only inspect per-entry errors from the TUNE file, and the
 * SEALED file is run exactly once at the end. Stated plainly so the final number is read with
 * the right amount of trust.
 *
 * Stratified by (repo, label) and interleaved, so both halves carry the same mix of projects and
 * the same positive rate — otherwise one half could end up easier than the other by accident.
 */
import { readFile, writeFile } from 'node:fs/promises';

interface Entry { repo: string; pr_number: number; label: string; [k: string]: unknown }

const all: Entry[] = JSON.parse(await readFile('corpus/heldout3-prs.json', 'utf-8'));

const groups = new Map<string, Entry[]>();
for (const e of all) {
  const key = `${e.repo}|${e.label}`;
  groups.set(key, [...(groups.get(key) ?? []), e]);
}

const tune: Entry[] = [];
const sealed: Entry[] = [];
// Roughly 1/3 tune, 2/3 sealed: the sealed half needs the larger share because it carries the
// gate measurement, and precision's confidence interval is driven by how many positives it holds.
for (const [, list] of [...groups.entries()].sort()) {
  list.forEach((e, i) => (i % 3 === 0 ? tune : sealed).push(e));
}

await writeFile('corpus/heldout3-TUNE.json', JSON.stringify(tune, null, 2), 'utf-8');
await writeFile('corpus/heldout3-SEALED.json', JSON.stringify(sealed, null, 2), 'utf-8');

const pc = (l: Entry[]) => `${l.length} entries, ${l.filter((e) => e.label === 'docs-relevant').length} positive`;
console.error(`TUNE:   ${pc(tune)}`);
console.error(`SEALED: ${pc(sealed)}`);
