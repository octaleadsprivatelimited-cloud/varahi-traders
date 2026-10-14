import type { RequestHandler } from "express";
import type { ZodTypeAny } from "zod";
import { AppError } from "./errors.js";
export const validate =
  (
    schema: ZodTypeAny,
    source: "body" | "query" | "params" = "body",
  ): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success)
      return next(
        new AppError(
          400,
          "VALIDATION_ERROR",
          "Invalid request",
          result.error.flatten(),
        ),
      );
    if (source === "query")
      Object.defineProperty(req, "query", {
        value: result.data,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    else (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
