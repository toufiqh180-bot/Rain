import type { FastifyReply } from "fastify";

/**
 * The error shape the web client already understands: `{ code, message, fields? }`.
 *
 * `message` is rendered to the person as-is, so write it for them, not for a log.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(code: string, message: string, fields?: Record<string, string>) {
    return new ApiError(400, code, message, fields);
  }
  static unauthorized(message = "Your session has ended. Sign in again to continue.") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "Your account does not have access to that.") {
    return new ApiError(403, "forbidden", message);
  }
  static notFound(message = "That is no longer available.") {
    return new ApiError(404, "not_found", message);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static tooMany(message = "Too many attempts. Wait a moment and try again.") {
    return new ApiError(429, "rate_limited", message);
  }
  static unavailable(message: string) {
    return new ApiError(503, "service_unavailable", message);
  }
}

export function send(reply: FastifyReply, status: number, body?: unknown) {
  if (body === undefined) return reply.code(204).send();
  return reply.code(status).send(body);
}
