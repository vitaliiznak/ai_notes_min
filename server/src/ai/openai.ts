import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError, type z } from "zod";
import { renderNote, renderSummaryInput, SUMMARY_AND_TAGS_SYSTEM, SUMMARY_SYSTEM, TAGS_SYSTEM } from "./prompts.js";
import { AI_MAX_RETRIES, AiError, SummaryAndTagsOutput, SummaryOutput, TagsOutput, type AiProvider, type OnText } from "./provider.js";

interface OpenAiProviderOptions {
  model: string;
  timeoutMs: number;
  apiKey?: string;
  /** Test seam: lets tests replay canned API responses without a key. */
  client?: OpenAI;
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): AiProvider {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: AI_MAX_RETRIES });

  /** One streamed request whose output must match `schema`. `name` is the schema's name and the log line's task. */
  async function callStructured<S extends z.ZodType>(
    name: string,
    instructions: string,
    schema: S,
    input: string,
    onText: OnText = () => {},
  ): Promise<z.infer<S>> {
    const started = Date.now();
    let usage: OpenAI.Responses.ResponseUsage | undefined;
    let outcome: "ok" | AiError["code"] = "ok";
    const stream = client.responses.stream({
      model: opts.model,
      instructions,
      input,
      text: { format: zodTextFormat(schema, name), verbosity: "low" },
      max_output_tokens: 4096,
      store: false, // notes are private; don't keep responses on the provider side
    });
    stream.on("response.output_text.delta", (event) => onText(event.delta));
    try {
      const response = await stream.finalResponse();
      usage = response.usage;
      const content = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
      if (content.some((part) => part.type === "refusal") || response.incomplete_details?.reason === "content_filter") {
        throw new AiError("refused", "The AI model declined to process this note.");
      }
      if (response.output_parsed == null) {
        throw new AiError("invalid_output", "The AI model returned an incomplete response.");
      }
      return response.output_parsed as z.infer<S>;
    } catch (err) {
      const aiError = toAiError(err);
      outcome = aiError.code;
      throw aiError;
    } finally {
      // One line per call, so latency, cost and failure rate can be read from the logs. Never the note's text.
      console.log(JSON.stringify({
        event: "ai_call",
        task: name,
        model: opts.model,
        ms: Date.now() - started,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        outcome,
      }));
    }
  }

  return {
    summarize: (note, onText) => callStructured("note_summary", SUMMARY_SYSTEM, SummaryOutput, renderSummaryInput(note), onText),
    generateTags: (note, onText) => callStructured("note_tags", TAGS_SYSTEM, TagsOutput, renderNote(note), onText),
    summarizeAndTag: (note, onText) =>
      callStructured("note_summary_and_tags", SUMMARY_AND_TAGS_SYSTEM, SummaryAndTagsOutput, renderSummaryInput(note), onText),
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
  const malformed = (e: unknown) => e instanceof ZodError || e instanceof SyntaxError;
  if (malformed(err) || (err instanceof Error && malformed(err.cause))) {
    return new AiError("invalid_output", "The AI model returned malformed output.", { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    // 4xx other than 429 means our request or credentials are wrong; 5xx is upstream trouble.
    return new AiError("unavailable", `The AI provider failed (${err.status ?? "network"}).`, { cause: err });
  }
  return new AiError("unavailable", "The AI provider is not available.", { cause: err });
}
