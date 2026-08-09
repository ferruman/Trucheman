export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function safeError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof DomainError)
    return { code: error.code, message: error.message, status: error.status };
  return { code: "internal_error", message: "The request could not be completed.", status: 500 };
}
