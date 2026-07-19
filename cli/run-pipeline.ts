#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { runPipeline } from '../pipeline/pipeline.js';

loadEnv({ path: '.env.local' });
loadEnv();

function parseArgs(argv: string[]) {
  const repoArg = argv.find((a) => a.includes('/') && !a.startsWith('-'));
  const prArg = argv.find((a) => /^\d+$/.test(a));
  const dryRun = argv.includes('--dry-run');
  if (!repoArg || !prArg) {
    console.error('Usage: npm run pipeline -- <owner/repo> <pr-number> [--dry-run]');
    process.exit(1);
  }
  const [owner, repo] = repoArg.split('/') as [string, string];
  return { owner, repo, prNumber: Number(prArg), dryRun };
}

async function main() {
  const { owner, repo, prNumber, dryRun } = parseArgs(process.argv.slice(2));
  const result = await runPipeline({ owner, repo }, prNumber, { dryRun });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2));
  process.exit(1);
});
