import { z } from "zod";
import type { AiTextStream } from "./stream.js";

/**
 * Raw shapes the model is asked to produce. Business rules (summaryCharLimit,
 * up to 5 tags) are enforced once, in notes/enrichment.ts, for every provider.
 * Length stays out of this schema so a maximum cannot cut a word.
 */
export const SummaryOutput = z.object({ summary: z.string() });
export const TagsOutput = z.object({ tags: z.array(z.string()) });
// Tags first: the model writes keys in schema order, so the short tags stream before the summary.
export const SummaryAndTagsOutput = TagsOutput.extend(SummaryOutput.shape);
export type SummaryOutput = z.infer<typeof SummaryOutput>;
export type TagsOutput = z.infer<typeof TagsOutput>;
export type SummaryAndTagsOutput = z.infer<typeof SummaryAndTagsOutput>;

export interface NoteText {
  title: string;
  content: string;
}

export interface AiProvider {
  summarize(note: NoteText): AiTextStream<SummaryOutput>;
  generateTags(note: NoteText): AiTextStream<TagsOutput>;
  /** Both results from one call, so the note's input tokens are paid for once. */
  summarizeAndTag(note: NoteText): AiTextStream<SummaryAndTagsOutput>;
}

export type AiErrorCode = "timeout" | "rate_limited" | "unavailable" | "refused" | "invalid_output";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiError";
  }
}
