import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError, type z } from "zod";
import { AI_ATTEMPTS } from "../config.js";
import { renderNote, renderSummaryInput, SUMMARY_AND_TAGS_SYSTEM, SUMMARY_SYSTEM, TAGS_SYSTEM } from "./prompts.js";
import { AiError, SummaryAndTagsOutput, SummaryOutput, TagsOutput, type AiProvider } from "./provider.js";
import { modelStream, type AiTextStream } from "./stream.js";

interface OpenAiProviderOptions {
  model: string;
  timeoutMs: number;
  apiKey?: string;
  /** Test seam: lets tests replay canned API responses without a key. */
  client?: OpenAI;
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): AiProvider {
  const client =
    opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: AI_ATTEMPTS - 1 });

  function run<S extends z.ZodType>(name: string, instructions: string, schema: S, input: string): AiTextStream<z.infer<S>> {
    return modelStream(async (emit) => {
      const stream = client.responses.stream({
        model: opts.model,
        instructions,
        input,
        text: { format: zodTextFormat(schema, name), verbosity: "low" },
        max_output_tokens: 4096,
        store: false, // notes are private; don't keep responses on the provider side
      });
      stream.on("response.output_text.delta", (event) => emit(event.delta));
      try {
        const response = await stream.finalResponse();
        const content = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
        if (content.some((part) => part.type === "refusal") || response.incomplete_details?.reason === "content_filter") {
          throw new AiError("refused", "The AI model declined to process this note.");
        }
        if (response.output_parsed == null) {
          throw new AiError("invalid_output", "The AI model returned an incomplete response.");
        }
        return response.output_parsed as z.infer<S>;
      } catch (err) {
        throw toAiError(err);
      }
    });
  }

  return {
    summarize: (note) => run("note_summary", SUMMARY_SYSTEM, SummaryOutput, renderSummaryInput(note)),
    generateTags: (note) => run("note_tags", TAGS_SYSTEM, TagsOutput, renderNote(note)),
    summarizeAndTag: (note) => run("note_summary_and_tags", SUMMARY_AND_TAGS_SYSTEM, SummaryAndTagsOutput, renderSummaryInput(note)),
  };
}

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiError("timeout", "The AI provider timed out.", { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AiError("rate_limited", "The AI provider is rate limiting requests.", { cause: err });
  }
  // responses.stream() wraps a schema failure in OpenAIError and keeps the ZodError as cause.
  const cause = err instanceof Error ? err.cause : undefined;
  if (err instanceof ZodError || cause instanceof ZodError || err instanceof SyntaxError || cause instanceof SyntaxError) {
    return new AiError("invalid_output", "The AI model returned malformed output.", { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    // 4xx other than 429 means our request or credentials are wrong; 5xx is upstream trouble.
    return new AiError("unavailable", `The AI provider failed (${err.status ?? "network"}).`, { cause: err });
  }
  return new AiError("unavailable", "The AI provider is not available.", { cause: err });
}
