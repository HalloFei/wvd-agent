/**
 * The first capture on a freshly spawned engine child, the way production takes it.
 *
 * Contracts §5 (`docs/specs/2026-10-24-contracts.md:229`): "The first request after an idle gap may
 * therefore find no frame and reply `timeout`; that is warm-up, not failure, and the World retries."
 * The child's 500 ms warm-up starts at module evaluation, before its encoder worker (jpeg-js/Koffi/
 * GDI+) has finished starting; under full-suite load that worker was measured ready 503–596 ms after
 * the banner, so the first reply can legitimately be `{ ok:false, error:'timeout', detail:'no-frame' }`.
 *
 * The policy is production's, not invented for tests: the attempt count and the wait between
 * attempts are imported from `src/tasks/steps.ts`, where `captureWithRetry` owns them. That does not
 * prove production uses them — `engine-child-warmup.test.ts` pins this helper's own 3 × 200 ms
 * sleeps — but a change to the production constants now moves the fixture in the same edit instead
 * of leaving a second copy to drift.
 *
 * Only that one documented warm-up reply is retried. A success, or any other failure (`rejected`,
 * `unavailable`, `stale-frame`, a request timeout), is returned at once: a hung renderer still fails
 * the caller after `CAPTURE_ATTEMPTS` bounded attempts, and no real failure is hidden behind the
 * retry.
 */
import type { EngineReply } from '../../src/contracts.ts';
import type { EngineRequester } from '../../src/engine/win32.ts';
import { CAPTURE_ATTEMPTS, CAPTURE_RETRY_MS } from '../../src/tasks/steps.ts';

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
  for (let attempt = 1; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    if (!isWarmupMiss(reply)) return reply;
    await sleep(CAPTURE_RETRY_MS);
    reply = await engine.request({ op: 'capture' });
  }
  return reply;
}
