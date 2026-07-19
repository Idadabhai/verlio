/** Exercises acceptWebhook() only — the fast path. No network, no model calls. */
import { createHmac } from 'node:crypto';
import { acceptWebhook, verifySignature, _resetIdempotencyState } from '../webhook/handler.js';

process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const sign = (body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const merged = JSON.stringify({
  action: 'closed',
  pull_request: { number: 42, merged: true },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
});

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

async function main() {
  _resetIdempotencyState();

  check('valid signature verifies', verifySignature(merged, sign(merged), secret));
  check('tampered body fails', !verifySignature(merged + ' ', sign(merged), secret));
  check('wrong-length signature fails (no throw)', !verifySignature(merged, 'sha256=abc', secret));
  check('missing signature fails', !verifySignature(merged, undefined, secret));

  const first = await acceptWebhook(merged, sign(merged), 'pull_request', 'delivery-1');
  check('merged PR is accepted', first.result.accepted && first.job?.prNumber === 42);

  const retry = await acceptWebhook(merged, sign(merged), 'pull_request', 'delivery-1');
  check('SAME delivery id is rejected as duplicate (GitHub retry)', !retry.result.accepted && (retry.result.reason ?? '').includes('duplicate'));

  const differentDelivery = await acceptWebhook(merged, sign(merged), 'pull_request', 'delivery-2');
  check('different delivery for same PR blocked while in flight', !differentDelivery.result.accepted && (differentDelivery.result.reason ?? '').includes('already processing'));

  _resetIdempotencyState();
  const otherPr = JSON.stringify({
    action: 'closed',
    pull_request: { number: 43, merged: true },
    repository: { owner: { login: 'acme' }, name: 'widgets' },
  });
  check('a different PR is still accepted', (await acceptWebhook(otherPr, sign(otherPr), 'pull_request', 'd3')).result.accepted);

  const notMerged = JSON.stringify({
    action: 'closed',
    pull_request: { number: 44, merged: false },
    repository: { owner: { login: 'acme' }, name: 'widgets' },
  });
  check('closed-but-not-merged is ignored', !(await acceptWebhook(notMerged, sign(notMerged), 'pull_request', 'd4')).result.accepted);
  check('non-pull_request event ignored', !(await acceptWebhook(merged, sign(merged), 'push', 'd5')).result.accepted);
  check('malformed JSON does not throw', !(await acceptWebhook('{oops', sign('{oops'), 'pull_request', 'd6')).result.accepted);

  const missingRepo = JSON.stringify({ action: 'closed', pull_request: { number: 1, merged: true }, repository: {} });
  check('payload missing repository is rejected', !(await acceptWebhook(missingRepo, sign(missingRepo), 'pull_request', 'd7')).result.accepted);

  let threw = false;
  try { await acceptWebhook(merged, 'sha256=deadbeef', 'pull_request', 'd8'); } catch { threw = true; }
  check('bad signature throws (never reaches pipeline)', threw);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
