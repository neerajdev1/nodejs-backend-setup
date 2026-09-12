/**
 * Errors the application raises deliberately. `isOperational` marks them as
 * expected failures that are safe to surface to the caller, as opposed to
 * unexpected crashes whose details must stay server-side.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(
    message: string,
    statusCode = 500,
    code = "INTERNAL_ERROR",
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(message, 400, "BAD_REQUEST", details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = "Request validation failed") {
    super(message, 400, "VALIDATION_ERROR", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists", details?: unknown) {
    super(message, 409, "CONFLICT", details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body is too large") {
    super(message, 413, "PAYLOAD_TOO_LARGE");
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests, please retry later") {
    super(message, 429, "TOO_MANY_REQUESTS");
  }
}
