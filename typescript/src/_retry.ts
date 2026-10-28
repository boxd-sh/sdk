/**
 * @internal
 * Retry policy, shared verbatim by `_transport.ts` (grpc-js) and
 * `_transportWeb.ts` (grpc-web/WS) — connection failures only, so
 * the two transports can never drift on when a call is safe to repeat, and
 * so the policy is unit-testable independent of either wire implementation
 * (see `tests/retry.test.ts`).
 */
import { isRetryable } from "./errors.js";

/** First backoff step; doubles per attempt. */
export const RETRY_BASE_MS = 250;
export const RETRY_MAX_MS = 4_000;

/**
 * Run `attempt`, retrying on connection failures only (never a timeout —
 * the request may have been applied — and never auth failures, which are
 * terminal: a rejection part-way through a session means the credential was
 * revoked, not that it went stale).
 */
export async function withRetries<T>(maxRetries: number, attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= maxRetries || !isRetryable(err)) throw err;
      await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** n));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
