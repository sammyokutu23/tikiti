/** An error whose message is safe to show to the end user. */
export class UserError extends Error {
  constructor(
    message: string,
    public code: string = "bad_request",
    public status = 400,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export class NotFoundError extends UserError {
  constructor(message = "Not found") {
    super(message, "not_found", 404);
  }
}

export class ForbiddenError extends UserError {
  constructor(message = "You don't have access to this.") {
    super(message, "forbidden", 403);
  }
}

export function userMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof UserError ? err.message : fallback;
}

/** Postgres unique_violation (23505), unwrapping Drizzle's query error wrapper. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
