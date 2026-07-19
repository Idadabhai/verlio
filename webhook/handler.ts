import { createHmac, timingSafeEqual } from 'node:crypto';
import { runPipeline } from '../pipeline/pipeline.js';
import type { PipelineResult } from '../pipeline/pipeline.js';
import { getDeliveryStore, _resetDeliveryStoreForTests } from '../lib/store.js';

/**
 * GitHub webhook receiver.
 *
 * THE CRITICAL CONSTRAINT: GitHub gives a webhook receiver ~10 seconds to respond, and treats a
 * timeout as a delivery failure — so it RETRIES. The Verlio pipeline makes two model calls
 * (classify, then draft) and comfortably exceeds that. The original implementation ran the whole
 * pipeline inline before responding, which meant every real merge would time out, be retried, and
 * be processed again: duplicated model spend, and a genuine risk of two doc PRs for one merge.
 *
 * So: verify and filter synchronously (fast, cheap), acknowledge immediately, and do the slow work
 * afterwards. Nothing that takes an unbounded amount of time may run before the acknowledgement.
 */

export function verifySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  // Length check first: timingSafeEqual throws on differing lengths. Both sides are fixed-length
  // hex for a well-formed signature, so this leaks nothing useful.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface GitHubPullRequestWebhookPayload {
  action: string;
  pull_request: { number: number; merged: boolean };
  repository: { owner: { login: string }; name: string };
}

export interface WebhookHandleResult {
  /** True when the event was accepted for processing. The work may not have finished yet. */
  accepted: boolean;
  reason?: string;
  /** Stable identifier for the work, for correlating logs with the eventual result. */
  jobId?: string;
}

export interface WebhookJob {
  jobId: string;
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Idempotency + in-flight tracking now goes through the pluggable DeliveryStore (lib/store.ts) —
 * an in-memory Set by default, or a durable Postgres-backed store when DATABASE_URL is set. See
 * lib/store.ts for why the in-memory default is not enough for multiple instances or a serverless
 * deployment (each invocation would start with an empty set, so GitHub's retries duplicate work).
 */

/** Exposed for tests. */
export function _resetIdempotencyState(): void {
  _resetDeliveryStoreForTests();
}

/**
 * Verify, filter, and decide whether this delivery should be processed. Fast (a couple of store
 * round-trips at most) and side-effect-light — safe to run inside the webhook request.
 */
export async function acceptWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  eventName: string | undefined,
  deliveryId: string | undefined,
): Promise<{ result: WebhookHandleResult; job?: WebhookJob }> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error('GITHUB_WEBHOOK_SECRET is not set');

  if (!verifySignature(rawBody, signatureHeader, secret)) {
    throw new Error('Invalid webhook signature');
  }

  if (eventName !== 'pull_request') {
    return { result: { accepted: false, reason: `ignored event: ${eventName}` } };
  }

  let payload: GitHubPullRequestWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubPullRequestWebhookPayload;
  } catch {
    return { result: { accepted: false, reason: 'malformed JSON payload' } };
  }

  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    return { result: { accepted: false, reason: 'not a merged pull_request' } };
  }

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const prNumber = payload.pull_request?.number;
  if (!owner || !repo || typeof prNumber !== 'number') {
    return { result: { accepted: false, reason: 'payload missing repository or PR number' } };
  }

  const store = getDeliveryStore();

  // GitHub retries the SAME delivery id on timeout or non-2xx. Seeing one twice means our previous
  // response was lost, not that anything new happened.
  if (deliveryId && (await store.isProcessed(deliveryId))) {
    return { result: { accepted: false, reason: `duplicate delivery ${deliveryId}` } };
  }

  // A second, different delivery for the same merged PR (e.g. a redelivery triggered by hand)
  // must not start a concurrent run that opens a second PR.
  const jobId = `${owner}/${repo}#${prNumber}`;
  if (!(await store.tryAcquireInFlight(jobId))) {
    return { result: { accepted: false, reason: `already processing ${jobId}` } };
  }

  if (deliveryId) await store.markProcessed(deliveryId);

  return { result: { accepted: true, jobId }, job: { jobId, owner, repo, prNumber } };
}

/**
 * The slow half: runs the pipeline. Call this AFTER responding to GitHub.
 * Never throws — a rejected floating promise would be an unhandled rejection that can take the
 * process down, and a webhook we have already acknowledged has nobody left to report an error to.
 */
export async function processWebhookJob(
  job: WebhookJob,
  opts: { dryRun?: boolean } = {},
): Promise<{ jobId: string; ok: true; result: PipelineResult } | { jobId: string; ok: false; error: string }> {
  try {
    const result = await runPipeline({ owner: job.owner, repo: job.repo }, job.prNumber, {
      dryRun: opts.dryRun ?? false,
    });
    return { jobId: job.jobId, ok: true, result };
  } catch (err) {
    return { jobId: job.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await getDeliveryStore().releaseInFlight(job.jobId);
  }
}

/**
 * Convenience wrapper for an HTTP handler: acknowledge now, process in the background.
 *
 * Async because acceptWebhook's store lookups are (at most a couple of indexed queries — still
 * fast enough to run inside the request, well under GitHub's ~10s timeout). `onComplete` is where
 * a real deployment should log or persist the outcome — once we have acknowledged the delivery,
 * GitHub will not tell us again, so a dropped result is lost for good.
 */
export async function handleWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  eventName: string | undefined,
  deliveryId: string | undefined,
  onComplete?: (outcome: Awaited<ReturnType<typeof processWebhookJob>>) => void,
): Promise<WebhookHandleResult> {
  const { result, job } = await acceptWebhook(rawBody, signatureHeader, eventName, deliveryId);
  if (job) {
    // Intentionally not awaited: the caller must respond to GitHub immediately.
    // processWebhookJob never rejects, so this cannot become an unhandled rejection.
    void processWebhookJob(job).then((outcome) => onComplete?.(outcome));
  }
  return result;
}
