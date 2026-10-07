import { setTimeout as sleep } from "node:timers/promises";
import { TAGS_MAX } from "../notes/limits.js";
import type { AiProvider, NoteText, SummaryOutput, TagsOutput } from "./provider.js";
import { modelStream, type AiTextStream } from "./stream.js";

const FALLBACK_TAG = "fake-ai";
const CHUNK = 8;
const CHUNK_DELAY_MS = 30;

const STOPWORDS = new Set(
  "about after also been before being from have into just more need only other over some than that their them then there these they this those through very what when where which while will with would your".split(" "),
);

/**
 * Deterministic stand-in so the app runs end to end without an API key
 * (AI_PROVIDER=fake). Output is prefixed so it can't be mistaken for a model.
 * Text is emitted in small pieces so the UI can show it arriving.
 */
export function createFakeProvider(): AiProvider {
  function streamed<T>(value: T): AiTextStream<T> {
    return modelStream(async (emit) => {
      const json = JSON.stringify(value);
      for (let i = 0; i < json.length; i += CHUNK) {
        emit(json.slice(i, i + CHUNK));
        await sleep(CHUNK_DELAY_MS);
      }
      return value;
    });
  }

  return {
    summarize: (note) => streamed(fakeSummary(note)),
    generateTags: (note) => streamed(fakeTags(note)),
    summarizeAndTag: (note) => streamed({ ...fakeTags(note), ...fakeSummary(note) }),
  };
}

function fakeSummary(note: NoteText): SummaryOutput {
  const title = note.title.slice(0, 40);
  const preview = note.content.replace(/\s+/g, " ").trim().slice(0, 140);
  return { summary: `[fake AI] Summary of "${title}". Begins: "${preview}…"` };
}

function fakeTags(note: NoteText): TagsOutput {
  const counts = new Map<string, number>();
  for (const word of `${note.title} ${note.content}`.toLowerCase().match(/\p{L}{4,}/gu) ?? []) {
    if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, TAGS_MAX);
  // A note with no usable word still needs a tag, or the result is rejected.
  return { tags: top.length > 0 ? top : [FALLBACK_TAG] };
}
