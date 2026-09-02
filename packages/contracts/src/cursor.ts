import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/** The only cursor payload version currently understood by LoongBoard. */
export const listCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    updatedAt: utcDateTimeSchema,
    number: z.number().int().positive(),
  })
  .strict();

export type ListCursorPayload = z.infer<typeof listCursorPayloadSchema>;

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode the final row's ordering key into an opaque URL-safe cursor. */
export function encodeListCursor(input: Omit<ListCursorPayload, "version">): string {
  const payload = listCursorPayloadSchema.parse({ version: 1, ...input });
  return encodeBase64Url(JSON.stringify(payload));
}

/**
 * Decode and validate a cursor. Callers should translate the thrown error to
 * the frozen INVALID_CURSOR API error rather than silently restarting at page
 * one.
 */
export function decodeListCursor(cursor: string): ListCursorPayload {
  if (!isBase64Url(cursor)) {
    throw new Error("Invalid list cursor");
  }

  try {
    const decoded = decodeBase64Url(cursor);
    return listCursorPayloadSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Invalid list cursor");
  }
}
