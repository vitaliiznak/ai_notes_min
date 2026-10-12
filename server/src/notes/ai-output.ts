import { parse } from "partial-json";
import { AiError } from "../ai/provider.js";
import type { AiField, AiPreview } from "../shared/notes.js";
import {
  charLength,
  SUMMARY_MAX_CHARS,
  summaryCharLimit,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TAGS_MIN,
  trimPadding,
} from "../shared/rules.js";

// What the model's output must be before it is stored, for every provider. A miss throws AiError and
// is not stored, so the next request tries again.

/** Business rule: one non-blank text no longer than summaryCharLimit(content). */
export function acceptSummary(output: { summary?: string }, content: string): string {
  const summary = trimPadding(output.summary ?? "");
  if (charLength(summary) < 1) {
    throw new AiError("invalid_output", "Expected a summary.");
  }
  const limit = summaryCharLimit(content);
  if (charLength(summary) > limit) {
    throw new AiError(
      "invalid_output",
      limit < SUMMARY_MAX_CHARS
        ? "Expected a summary at least 20% shorter than the note."
        : `Expected a summary of at most ${SUMMARY_MAX_CHARS} characters.`,
    );
  }
  return summary;
}

/** Lowercase, no leading "#" or edge padding, inner whitespace collapsed to one space. */
function normalizeTag(raw: string): string {
  const withoutHash = trimPadding(raw).replace(/^#+/, "");
  return trimPadding(withoutHash).replace(/\s+/g, " ").toLowerCase();
}

const fitsTag = (tag: string) => charLength(tag) > 0 && charLength(tag) <= TAG_MAX_LENGTH;

/** Normalized tags without empty, over-long or repeated ones, the first 5 kept (the model ranks by relevance). */
function normalizeTags(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeTag).filter(fitsTag))].slice(0, TAGS_MAX);
}

/** Business rule: 1–5 distinct, normalized tags. */
export function acceptTags(output: { tags?: string[] }): string[] {
  const tags = normalizeTags(output.tags ?? []);
  if (tags.length < TAGS_MIN) {
    throw new AiError("invalid_output", `Expected at least ${TAGS_MIN} ${TAGS_MIN === 1 ? "tag" : "tags"}.`);
  }
  return tags;
}

/**
 * One field of the model's JSON so far (partial-json also reads a string it is still writing), normalized
 * the way it will be stored. Not validated; the finished output still goes through acceptSummary/acceptTags.
 */
export function parsePartialField(field: AiField, text: string): AiPreview | null {
  let value: unknown;
  try {
    value = parse(text)?.[field];
  } catch {
    return null;
  }
  if (field === "summary") {
    const summary = typeof value === "string" ? trimPadding(value) : "";
    return summary ? { summary } : null;
  }
  const tags = Array.isArray(value) ? normalizeTags(value.filter((tag) => typeof tag === "string")) : [];
  return tags.length > 0 ? { tags } : null;
}
