import { z } from "zod";
import { charLength, CONTENT_MAX, normalizeUserText, TITLE_MAX } from "./limits.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Postgres text cannot store a null byte, and a lone surrogate is not Unicode. */
function isStorableText(value: string): boolean {
  return !value.includes("\0") && !LONE_SURROGATE.test(value);
}

function userText(max: number, label: string) {
  const required = `${label} is required.`;
  const unsupported = `${label} contains a character that can't be stored.`;
  const tooLong = `${label} must be at most ${max} characters.`;
  return z.string().transform((value, ctx) => {
    const text = normalizeUserText(value);
    if (!isStorableText(text)) {
      ctx.addIssue({ code: "custom", message: unsupported });
      return z.NEVER;
    }
    if (charLength(text) < 1) {
      ctx.addIssue({ code: "custom", message: required });
      return z.NEVER;
    }
    if (charLength(text) > max) {
      ctx.addIssue({ code: "custom", message: tooLong });
      return z.NEVER;
    }
    return text;
  });
}

export const CreateNoteInput = z.object({
  title: userText(TITLE_MAX, "Title"),
  content: userText(CONTENT_MAX, "Content"),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;
