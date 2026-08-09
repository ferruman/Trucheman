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
