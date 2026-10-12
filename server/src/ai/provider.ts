import { z } from "zod";
import type { AiErrorCode } from "../shared/error-codes.js";

/**
 * Raw shapes the model is asked to produce. Business rules (summaryCharLimit,
 * up to 5 tags) are enforced once, in notes/ai-output.ts, for every provider.
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

/** Receives each piece of the model's raw text as it arrives. */
export type OnText = (delta: string) => void;

/** Each call resolves with the parsed output, and passes its text to `onText` while it is written. */
export interface AiProvider {
  summarize(note: NoteText, onText?: OnText): Promise<SummaryOutput>;
  generateTags(note: NoteText, onText?: OnText): Promise<TagsOutput>;
  /** Both results from one call, so the note's input tokens are paid for once. */
  summarizeAndTag(note: NoteText, onText?: OnText): Promise<SummaryAndTagsOutput>;
}

/** Retries an adapter may make after a failed attempt. Shutdown waits for every attempt (drainBudgetMs in config.ts). */
export const AI_MAX_RETRIES = 1;

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
