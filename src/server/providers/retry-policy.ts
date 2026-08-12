export type RetryDecision = { retry: boolean; delayMs: number; reason: string };
export function retryDecision(
  error: { kind: string; status?: number },
  attempt: number,
  maxRetries = 3,
  retryAfterMs?: number,
): RetryDecision {
  const retryable = error.kind === "temporary" || error.kind === "invalid_response";
  // A dropped connection is not the batch's fault: the identical request works again once the
  // network is back, while an invalid response repeats until the question changes — which is
  // why the caller halves the batch instead of asking a fifth time. Measured on one run: four
  // connection drops in an hour, three of them ridden out inside the ~3.5s that three attempts
  // buy, and the fourth outlasted it and killed a book at 131 of 137 batches. Five attempts
  // cover ~15s; a provider that is down for longer is down, and the checkpoints are the answer.
  const budget = error.kind === "temporary" ? maxRetries + 2 : maxRetries;
  if (!retryable || attempt >= budget)
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
