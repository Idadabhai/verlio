import { Pool } from 'pg';

/**
 * Idempotency + in-flight tracking, pluggable so a self-hosted single-process deployment and a
 * durable multi-instance one can share the same webhook code.
 */
export interface DeliveryStore {
  isProcessed(deliveryId: string): Promise<boolean>;
  markProcessed(deliveryId: string): Promise<void>;
  /** Atomically claims jobId; returns false if another caller already holds it. */
  tryAcquireInFlight(jobId: string): Promise<boolean>;
  releaseInFlight(jobId: string): Promise<void>;
}

const MAX_REMEMBERED_DELIVERIES = 10_000;

/**
 * In-memory store — the original M1/M2 implementation. Correct for one long-lived process,
 * useless across multiple instances or serverless invocations (each starts empty, so GitHub's
 * retries duplicate work again). Kept as the zero-config default for local testing only —
 * production and any horizontally-scaled deployment must set DATABASE_URL instead (see
 * getDeliveryStore below). This is the M3 groundwork item from verlio_CHANGELOG.md.
 */
class InMemoryDeliveryStore implements DeliveryStore {
  private processed = new Set<string>();
  private inFlight = new Set<string>();

  async isProcessed(deliveryId: string): Promise<boolean> {
    return this.processed.has(deliveryId);
  }

  async markProcessed(deliveryId: string): Promise<void> {
    if (this.processed.size >= MAX_REMEMBERED_DELIVERIES) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
    this.processed.add(deliveryId);
  }

  async tryAcquireInFlight(jobId: string): Promise<boolean> {
    if (this.inFlight.has(jobId)) return false;
    this.inFlight.add(jobId);
    return true;
  }

  async releaseInFlight(jobId: string): Promise<void> {
    this.inFlight.delete(jobId);
  }

  /** Test-only. */
  _reset(): void {
    this.processed.clear();
    this.inFlight.clear();
  }
}

/**
 * A stuck job (process crashed mid-pipeline) must eventually be re-claimable, or that PR's docs
 * drift is permanently unreported. classify+draft+PR comfortably finishes in well under this.
 */
const STALE_IN_FLIGHT_MS = 15 * 60 * 1000;

/**
 * Postgres-backed store — durable across restarts and shared across multiple instances /
 * serverless invocations, which the in-memory store above cannot do.
 *
 * Uses plain `pg`, not `@neondatabase/serverless`: Verlio ships as a self-hosted OSS package, and
 * whoever runs it points DATABASE_URL at whatever Postgres they already have (Neon, Supabase,
 * RDS, a local instance) — a portable wire-protocol driver is the right choice for that, not a
 * provider-specific one tied to Irfan's own hosted-stack convention.
 *
 * `verlio_in_flight_jobs` uses a DB-level UNIQUE primary key as the acquire lock: `INSERT ... ON
 * CONFLICT DO NOTHING` atomically decides the race between concurrent instances, which a
 * separate SELECT-then-INSERT could not.
 */
class PostgresDeliveryStore implements DeliveryStore {
  private pool: Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS verlio_processed_deliveries (
        delivery_id TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS verlio_in_flight_jobs (
        job_id TEXT PRIMARY KEY,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async isProcessed(deliveryId: string): Promise<boolean> {
    await this.ready;
    const { rows } = await this.pool.query(
      'SELECT 1 FROM verlio_processed_deliveries WHERE delivery_id = $1',
      [deliveryId],
    );
    return rows.length > 0;
  }

  async markProcessed(deliveryId: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      'INSERT INTO verlio_processed_deliveries (delivery_id) VALUES ($1) ON CONFLICT (delivery_id) DO NOTHING',
      [deliveryId],
    );
  }

  async tryAcquireInFlight(jobId: string): Promise<boolean> {
    await this.ready;
    // Reap a stale claim from a crashed process before attempting to acquire, or a single crash
    // mid-pipeline would permanently block that job from ever being retried.
    await this.pool.query(
      `DELETE FROM verlio_in_flight_jobs WHERE job_id = $1 AND acquired_at < now() - interval '${STALE_IN_FLIGHT_MS / 1000} seconds'`,
      [jobId],
    );
    const { rowCount } = await this.pool.query(
      'INSERT INTO verlio_in_flight_jobs (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING',
      [jobId],
    );
    return (rowCount ?? 0) > 0;
  }

  async releaseInFlight(jobId: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM verlio_in_flight_jobs WHERE job_id = $1', [jobId]);
  }
}

let _store: DeliveryStore | null = null;

/**
 * Picks the durable Postgres store when DATABASE_URL is configured, otherwise falls back to the
 * in-memory store with a loud warning — never silently. A missing DATABASE_URL in a real
 * deployment should be a visible operational fact, not a quiet correctness bug discovered later
 * as duplicated PRs.
 */
export function getDeliveryStore(): DeliveryStore {
  if (_store) return _store;
  const url = process.env.DATABASE_URL;
  if (url) {
    _store = new PostgresDeliveryStore(url);
  } else {
    console.warn(
      '[verlio] No DATABASE_URL configured — using an in-memory idempotency store. Fine for ' +
        'local testing; loses all state on restart and cannot be shared across multiple instances ' +
        'or serverless invocations. Set DATABASE_URL before running Verlio horizontally scaled.',
    );
    _store = new InMemoryDeliveryStore();
  }
  return _store;
}

/** Test-only: force a fresh store on the next getDeliveryStore() call. */
export function _resetDeliveryStoreForTests(): void {
  _store = null;
}
