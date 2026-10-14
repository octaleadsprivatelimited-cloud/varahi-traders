import type { ErrorRequestHandler, RequestHandler } from "express";
import { internalFailureSummary } from "./http-security.js";
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound: RequestHandler = (_req, _res, next) =>
  next(new AppError(404, "NOT_FOUND", "Resource not found"));
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const bodyErrors: Record<string, { status: number; code: string; message: string }> = {
    "entity.parse.failed": { status: 400, code: "INVALID_JSON", message: "Request body must be valid JSON" },
    "entity.too.large": { status: 413, code: "REQUEST_TOO_LARGE", message: "Request body is too large" },
    "charset.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING", message: "Request encoding is not supported" },
    "encoding.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING", message: "Request encoding is not supported" },
  };
  const bodyError = error && typeof error.type === "string" ? bodyErrors[error.type] : undefined;
  if (bodyError) { const { status, ...safe } = bodyError; res.status(status).json({ success: false, error: safe }); return; }
  const known = error instanceof AppError;
  const status = known ? error.status : 500;
  if (!known) _req.log?.error(internalFailureSummary(error));
  res.status(status).json({
    success: false,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "An unexpected error occurred",
      ...(known && error.details ? { details: error.details } : {}),
    },
  });
};
