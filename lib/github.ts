import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

interface GithubAppAuthConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

/**
 * GitHub App creds are all-or-nothing: a partial set (e.g. APP_ID without the private key)
 * almost certainly means a copy-paste mistake, not an intent to fall back to GITHUB_TOKEN.
 */
function readAppAuthConfig(): GithubAppAuthConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!appId && !privateKey && !installationId) return null;
  if (!appId || !privateKey || !installationId) {
    throw new Error(
      'Incomplete GitHub App credentials: GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and ' +
        'GITHUB_APP_INSTALLATION_ID must all be set together (or all left unset to fall back ' +
        'to GITHUB_TOKEN).',
    );
  }
  return { appId, privateKey, installationId };
}

/**
 * Belt-and-suspenders enforcement of "never auto-merge" (CLAUDE.md, council Condition 1). GitHub
 * has no permission narrower than "Contents: write + Pull requests: write" that still allows
 * opening a PR with real file changes — and that same pair is exactly what the merge endpoint
 * (`PUT .../pulls/{number}/merge`) requires. So the App's permission grant is technically
 * sufficient to merge a PR; the standing rule is enforced entirely by no code path calling it.
 * Guard that in code too, so an accidental future call fails loudly instead of silently reaching
 * GitHub — a security-audit finding, not a hypothetical.
 */
function blockMerge(client: Octokit): void {
  const blocked: typeof client.pulls.merge = (() => {
    throw new Error('Verlio never merges pull requests — this call path must not exist.');
  }) as unknown as typeof client.pulls.merge;
  client.pulls.merge = blocked;
}

let _client: Octokit | null = null;
function getClient(): Octokit {
  if (_client) return _client;

  const appAuth = readAppAuthConfig();
  if (appAuth) {
    _client = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: appAuth.appId,
        privateKey: appAuth.privateKey,
        installationId: appAuth.installationId,
      },
    });
    blockMerge(_client);
    return _client;
  }

  // Legacy path (M1/M2 skeleton). Council Condition 1 wants the GitHub App path above as the
  // real one — this only exists so pre-M3 test scripts and corpus tooling keep working.
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    // M2 found that a missing credential silently degraded Octokit to unauthenticated
    // requests (60/hr) and died ~26 calls in, looking like rate limiting rather than auth.
    // Fail loudly instead, at the point the client is first needed.
    throw new Error(
      'No GitHub credentials configured. Set GITHUB_APP_ID + GITHUB_PRIVATE_KEY + ' +
        'GITHUB_APP_INSTALLATION_ID (preferred — PR-creation scope only) or GITHUB_TOKEN ' +
        '(personal access token, broader scope) in .env.local.',
    );
  }
  console.warn(
    '[verlio] Using GITHUB_TOKEN (personal access token) instead of the GitHub App. This ' +
      'grants broader repo access than council Condition 1 allows for production use — set ' +
      'GITHUB_APP_ID/GITHUB_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID instead.',
  );
  _client = new Octokit({ auth: token });
  blockMerge(_client);
  return _client;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface MergedPR {
  number: number;
  title: string;
  body: string;
  diff: string;
  baseBranch: string;
  mergeCommitSha: string;
}

export async function getMergedPR(ref: RepoRef, prNumber: number): Promise<MergedPR> {
  const octokit = getClient();
  const { data: pr } = await octokit.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: prNumber });
  if (!pr.merged || !pr.merge_commit_sha) {
    throw new Error(`PR #${prNumber} is not merged`);
  }
  const { data: diff } = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    diff: diff as unknown as string,
    baseBranch: pr.base.ref,
    mergeCommitSha: pr.merge_commit_sha,
  };
}

const CANDIDATE_DOC_PATTERNS = [/^readme\.md$/i, /^docs\/.*\.md$/i, /^documentation\/.*\.md$/i];

export async function listCandidateDocFiles(ref: RepoRef, branch: string, limit = 6): Promise<Array<{ path: string; content: string }>> {
  const octokit = getClient();
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: branch,
    recursive: '1',
  });

  const candidatePaths = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path && CANDIDATE_DOC_PATTERNS.some((p) => p.test(entry.path!)))
    .map((entry) => entry.path!)
    .slice(0, limit);

  const files: Array<{ path: string; content: string }> = [];
  for (const path of candidatePaths) {
    try {
      const { data } = await octokit.repos.getContent({ owner: ref.owner, repo: ref.repo, path, ref: branch });
      if (!Array.isArray(data) && data.type === 'file' && data.content) {
        files.push({ path, content: Buffer.from(data.content, 'base64').toString('utf-8') });
      }
    } catch {
      // File listed in tree but unreadable (submodule, symlink, etc.) — skip.
    }
  }
  return files;
}

export interface OpenDocPRInput {
  ref: RepoRef;
  baseBranch: string;
  triggeringPr: { number: number; title: string; url: string };
  classificationRationale: string;
  edits: Array<{ path: string; new_content: string; rationale: string }>;
  summary: string;
}

export async function openDocPR(input: OpenDocPRInput): Promise<{ url: string; number: number }> {
  const octokit = getClient();
  const { ref, baseBranch, triggeringPr, edits } = input;

  const { data: baseRef } = await octokit.git.getRef({ owner: ref.owner, repo: ref.repo, ref: `heads/${baseBranch}` });
  const branchName = `verlio/docs-pr-${triggeringPr.number}`;

  await octokit.git.createRef({
    owner: ref.owner,
    repo: ref.repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha,
  }).catch(async (err) => {
    if (err.status === 422) {
      // Branch already exists (retry) — reset it to base so we don't stack stale commits.
      await octokit.git.updateRef({
        owner: ref.owner,
        repo: ref.repo,
        ref: `heads/${branchName}`,
        sha: baseRef.object.sha,
        force: true,
      });
    } else {
      throw err;
    }
  });

  for (const edit of edits) {
    let existingSha: string | undefined;
    try {
      const { data: existing } = await octokit.repos.getContent({ owner: ref.owner, repo: ref.repo, path: edit.path, ref: branchName });
      if (!Array.isArray(existing) && existing.type === 'file') existingSha = existing.sha;
    } catch {
      // File doesn't exist yet — create it.
    }
    await octokit.repos.createOrUpdateFileContents({
      owner: ref.owner,
      repo: ref.repo,
      path: edit.path,
      message: `docs: update ${edit.path} for #${triggeringPr.number}`,
      content: Buffer.from(edit.new_content, 'utf-8').toString('base64'),
      branch: branchName,
      sha: existingSha,
    });
  }

  const body = [
    `Verlio detected that [#${triggeringPr.number}](${triggeringPr.url}) ("${triggeringPr.title}") changed documented behavior.`,
    '',
    `**Why:** ${input.classificationRationale}`,
    '',
    `**What changed:** ${input.summary}`,
    '',
    ...edits.map((e) => `- \`${e.path}\`: ${e.rationale}`),
    '',
    '_This PR was opened automatically by Verlio. It never auto-merges — review and merge only if the change is correct._',
  ].join('\n');

  const { data: pr } = await octokit.pulls.create({
    owner: ref.owner,
    repo: ref.repo,
    title: `docs: sync with #${triggeringPr.number}`,
    head: branchName,
    base: baseBranch,
    body,
  });

  return { url: pr.html_url, number: pr.number };
}
