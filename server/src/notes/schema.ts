import { z } from "zod";
import { charLength, CONTENT_MAX, normalizeUserText, TITLE_MAX } from "./limits.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Postgres text cannot store a null byte, and a lone surrogate is not Unicode. */
function isStorableText(value: string): boolean {
  return !value.includes("\0") && !LONE_SURROGATE.test(value);
}

// Measured after normalizing, as stored. Each check stops the chain, so a field gets one message.
function userText(max: number, label: string) {
  return z
    .string()
    .transform(normalizeUserText)
    .refine(isStorableText, { message: `${label} contains a character that can't be stored.`, abort: true })
    .refine((text) => charLength(text) >= 1, { message: `${label} is required.`, abort: true })
    .refine((text) => charLength(text) <= max, { message: `${label} must be at most ${max} characters.` });
}

export const CreateNoteInput = z.object({
  title: userText(TITLE_MAX, "Title"),
  content: userText(CONTENT_MAX, "Content"),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;
