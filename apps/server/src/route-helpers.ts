import type { FastifyReply } from "fastify";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";

/**
 * 400 helper shared by route modules: parse or throw InvalidRequestError.
 * The schema's input side is explicitly `unknown` so preprocess-based
 * schemas (e.g. repeated query params) infer their OUTPUT type here.
 */
export function parseRequest<Output>(
  schema: ZodType<Output, ZodTypeDef, unknown>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRequestError(formatZodError(parsed.error));
  }
  return parsed.data;
}

export function assertEmptyRequestBody(body: unknown): void {
  if (body !== undefined) {
    throw new InvalidRequestError("Request body must be empty");
  }
}

/** Validate the response payload at the boundary before sending it. */
export function sendParsed<T>(
  reply: FastifyReply,
  statusCode: number,
  schema: ZodType<T>,
  value: unknown,
): FastifyReply {
  return reply.code(statusCode).send(schema.parse(value));
}

export class InvalidRequestError extends Error {
  readonly code = "INVALID_REQUEST" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "request" : issue.path.join(".");
      return `${path} ${issue.message}`;
    })
    .join("; ");
}
