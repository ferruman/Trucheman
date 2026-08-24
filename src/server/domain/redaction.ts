const secretLike = /(api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*[^\s,;]+/gi;
export function redact(value: unknown): string {
  return String(value)
    .replace(secretLike, "$1=[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
export function safeProviderError(status: number, requestId?: string) {
  return {
    status,
    requestId,
    kind:
      status === 401 || status === 403
        ? "configuration"
        : status === 429 || status >= 500
          ? "temporary"
          : "provider_error",
  };
}
