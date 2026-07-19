#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runPipeline } from '../pipeline/pipeline.js';

/**
 * Verlio's MCP server — the one-command install path for Claude Code/Cursor (M3, PROJECT_BRIEF.md).
 * stdio transport: the calling agent spawns this as a child process, no separate deployment.
 * Every tool returns the same structured JSON the CLI does (Nevo's rule, CLAUDE.md) — a text
 * content block containing the serialized PipelineResult, not prose.
 */

// Read from package.json rather than hardcoding — a hardcoded literal here already drifted from
// the real published version once (shipped as "0.1.0" inside the v0.1.1 tarball).
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const server = new McpServer({ name: 'verlio', version });

const repoShape = {
  repo: z.string().describe('GitHub repo as "owner/name", e.g. "octokit/octokit.js"'),
  pr_number: z.number().int().positive().describe('The merged pull request number to check'),
};

function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Expected a "owner/repo" string, got "${repo}"`);
  return { owner, repo: name };
}

server.registerTool(
  'check_docs_drift',
  {
    title: 'Check documentation drift',
    description:
      'Classify whether a merged GitHub pull request is documentation-relevant, and preview the ' +
      'drafted doc fix if it is. Read-only — never opens a pull request, regardless of the verdict.',
    inputSchema: repoShape,
  },
  async ({ repo, pr_number }) => {
    const result = await runPipeline(parseRepo(repo), pr_number, { dryRun: true });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'open_docs_pr',
  {
    title: 'Open a documentation-fix pull request',
    description:
      'Classify a merged pull request and, if it is confidently documentation-relevant, open a ' +
      'real pull request on the repo with the drafted doc fix. Never auto-merges — the opened PR ' +
      'always requires human review, per Verlio\'s standing rule.',
    inputSchema: repoShape,
  },
  async ({ repo, pr_number }) => {
    const result = await runPipeline(parseRepo(repo), pr_number, { dryRun: false });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
