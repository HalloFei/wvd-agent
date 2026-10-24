/**
 * The first capture on a freshly spawned engine child, the way production takes it.
 *
 * Contracts §5 (`docs/specs/2026-10-24-contracts.md:229`): "The first request after an idle gap may
 * therefore find no frame and reply `timeout`; that is warm-up, not failure, and the World retries."
 * The child's 500 ms warm-up starts at module evaluation, before its encoder worker (jpeg-js/Koffi/
 * GDI+) has finished starting; under full-suite load that worker was measured ready 503–596 ms after
 * the banner, so the first reply can legitimately be `{ ok:false, error:'timeout', detail:'no-frame' }`.
 *
 * The policy below is production's, not invented for tests:
 * - three attempts total: `WARMUP_TICKS = 3` (`src/world.ts:162`) and `CAPTURE_ATTEMPTS = 3`
 *   (`src/tasks/steps.ts:78`, `captureWithRetry`) are both three;
 * - 200 ms between attempts: `CAPTURE_RETRY_MS = 200` (`src/tasks/steps.ts:80`).
 *
 * Only that one documented warm-up reply is retried. A success, or any other failure (`rejected`,
 * `unavailable`, `stale-frame`, a request timeout), is returned at once: a hung renderer still fails
 * the caller after three bounded attempts, and no real failure is hidden behind the retry.
 */
import type { EngineReply } from '../../src/contracts.ts';
import type { EngineRequester } from '../../src/engine/win32.ts';

/** Total attempts, warm capture included — `WARMUP_TICKS` / `CAPTURE_ATTEMPTS` in production. */
const WARMUP_CAPTURE_ATTEMPTS = 3;

/** Delay between attempts — `CAPTURE_RETRY_MS` in production. */
const WARMUP_CAPTURE_RETRY_MS = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one reply contracts §5 calls warm-up rather than failure. */
function isWarmupMiss(reply: EngineReply): boolean {
  return !reply.ok && reply.error === 'timeout' && reply.detail === 'no-frame';
}

/**
 * Requests the first capture, retrying only a warm-up `no-frame` reply on the first capture.
 *
 * Takes the engine's request surface (`EngineRequester`, the same shape `EngineClient` satisfies) and
 * returns the last reply it got. `sleep` is injectable so unit tests can observe the spacing without
 * waiting; it defaults to a real timer.
 */
export async function captureWarm(
  engine: EngineRequester,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<EngineReply> {
  let reply = await engine.request({ op: 'capture' });
  for (let attempt = 1; attempt < WARMUP_CAPTURE_ATTEMPTS; attempt += 1) {
    if (!isWarmupMiss(reply)) return reply;
    await sleep(WARMUP_CAPTURE_RETRY_MS);
    reply = await engine.request({ op: 'capture' });
  }
  return reply;
}
