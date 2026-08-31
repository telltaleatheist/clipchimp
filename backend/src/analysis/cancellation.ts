/**
 * ONE cancellation primitive for the whole analysis pipeline.
 *
 * The queue can cancel an in-flight AI job at any moment, and "cancelled" has to
 * mean three different things at three different depths:
 *
 *   1. the HTTP request currently generating must be torn down (an AbortSignal),
 *   2. every stage loop must refuse to start the NEXT unit of work
 *      (`ensureNotCancelled` before each call), and
 *   3. no error handler anywhere may mistake a cancellation for a FAILURE — the
 *      pipeline is full of catch blocks that record failures, degrade to a
 *      weaker path, or retry, and every one of them would happily keep the GPU
 *      busy for another twenty minutes after the user pressed stop.
 *
 * A single AbortSignal carries (1) and (2); `AnalysisCancelledError` carries (3)
 * as a TYPE rather than a string, so `isCancellation` never has to guess from a
 * message — which matters because the same code path also aborts on the
 * ai-provider's 10-minute request timeout, and THAT is a genuine failure.
 */

export class AnalysisCancelledError extends Error {
  /** Structural marker: survives error re-wrapping and cross-realm instances. */
  readonly cancelled = true;

  constructor(message = 'Analysis cancelled') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

/**
 * True only for a deliberate user/queue cancellation — never for a timeout, a
 * wedged Ollama, or an aborted request that nobody asked to abort. Checked by
 * every catch block that would otherwise swallow the error and continue.
 */
export function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AnalysisCancelledError) return true;
  return (error as { cancelled?: unknown }).cancelled === true;
}

/**
 * Throw if the run has been cancelled. Called at the top of every loop
 * iteration and before every stage, so a cancelled run stops ISSUING work
 * rather than merely aborting the one call that happened to be open.
 */
export function ensureNotCancelled(signal?: AbortSignal, what?: string): void {
  if (signal?.aborted) {
    throw new AnalysisCancelledError(what ? `Analysis cancelled before ${what}` : 'Analysis cancelled');
  }
}
