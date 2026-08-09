export type RetryDecision = { retry: boolean; delayMs: number; reason: string };
export function retryDecision(
  error: { kind: string; status?: number },
  attempt: number,
  maxRetries = 3,
  retryAfterMs?: number,
): RetryDecision {
  const retryable = error.kind === "temporary" || error.kind === "invalid_response";
  if (!retryable || attempt >= maxRetries)
    return { retry: false, delayMs: 0, reason: "not-retryable-or-exhausted" };
  const base = retryAfterMs ?? Math.min(30000, 500 * 2 ** attempt);
  return {
    retry: true,
    delayMs: Math.round(base * (0.8 + Math.random() * 0.4)),
    reason: "bounded-retry",
  };
}
export async function abortableDelay(ms: number, signal?: AbortSignal) {
  // addEventListener never fires on an already-aborted signal, so without this check a
  // pause requested mid-request still waited out the full backoff before taking effect.
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
