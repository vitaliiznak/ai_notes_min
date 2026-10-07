import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  api,
  canSummarize,
  clampText,
  CONTENT_MAX,
  errorMessage,
  normalizeUserText,
  noteLength,
  saveAttemptKey,
  storedNoteText,
  SUMMARY_MIN_CONTENT,
  TITLE_MAX,
  type Note,
} from "../api";
import { readStorage, usePageTitle, writeStorage } from "../browser";
import { SAMPLE_NOTES, type SampleNote } from "../demo-notes";
import { BackLink } from "./BackLink";
import { Sparkle } from "./Sparkle";

const shortcut =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

interface Draft {
  title: string;
  content: string;
  idempotencyKey?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One unsaved draft, kept until it is saved or discarded.
const DRAFT_KEY = "ai-notes.draft";

function readDraft(): Draft {
  try {
    const stored = JSON.parse(readStorage(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    const idempotencyKey = typeof stored?.idempotencyKey === "string" && UUID.test(stored.idempotencyKey)
      ? stored.idempotencyKey
      : undefined;
    return {
      title: typeof stored?.title === "string" ? stored.title : "",
      content: typeof stored?.content === "string" ? stored.content : "",
      idempotencyKey,
    };
  } catch {
    return { title: "", content: "" };
  }
}

function writeDraft(draft: Draft | null) {
  writeStorage(DRAFT_KEY, draft ? JSON.stringify(draft) : null);
}

// A random v4 UUID for the Idempotency-Key header. crypto.randomUUID only exists over HTTPS,
// and the cluster deploy serves plain HTTP, so it is built from getRandomValues.
function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Shown only near the cap, so an ordinary note has no numbers around it.
function Limit({ length, max }: { length: number; max: number }) {
  if (length < max * 0.9) return null;
  return (
    <p className="counter" aria-hidden="true">
      {length.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
    </p>
  );
}

// Says before saving what the AI will do with this note, so a missing summary is never a surprise.
function AiOnSave({ content }: { content: string }) {
  const length = noteLength(content);
  const remaining = SUMMARY_MIN_CONTENT - length;
  const summarized = canSummarize(content);
  return (
    <p className={summarized ? "ai-plan is-summarized" : "ai-plan"}>
      <Sparkle />
      {summarized ? (
        <span>AI will tag and summarize this note when you save.</span>
      ) : (
        <span>
          AI tags every note when you save. Summaries are for notes of {SUMMARY_MIN_CONTENT}+ characters
          {length > 0 && <span className="ai-plan-count"> ({remaining} to go)</span>}.
        </span>
      )}
    </p>
  );
}

// Test fixture, not part of the product: fills the form so someone can try AI without typing.
// Saving still goes through the normal path.
function SampleGallery({
  current,
  onPick,
  disabled,
}: {
  current: SampleNote | undefined;
  onPick: (note: SampleNote) => void;
  disabled: boolean;
}) {
  return (
    <section className="samples" aria-labelledby="samples-heading">
      <div className="samples-head">
        <span className="demo-badge">Test only</span>
        <div>
          <h2 id="samples-heading">Sample notes</h2>
          <p className="samples-note">
            For trying the app. Picking one only fills the form — nothing is saved until you press Save note.
          </p>
        </div>
      </div>
      <ul className="samples-list">
        {SAMPLE_NOTES.map((note) => {
          const length = noteLength(note.content);
          return (
            <li key={note.title}>
              <button type="button" className="sample" aria-pressed={note === current} disabled={disabled} onClick={() => onPick(note)}>
                <span className="sample-title">{note.title}</span>
                <span className="sample-meta">
                  {canSummarize(note.content) ? "Summary + tags" : "Tags only"} · {length.toLocaleString("en-US")}{" "}
                  characters
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function NewNoteForm({ onCreated }: { onCreated: (note: Note) => void }) {
  const [draft] = useState(readDraft);
  const [title, setTitle] = useState(draft.title);
  const [content, setContent] = useState(draft.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  // Retrying the same text reuses its key, so a save that reached the server before the
  // connection failed is not stored twice. The key lives in the draft, so a reload does too.
  const saveKey = useRef<{ text: string; key: string } | null>(
    draft.idempotencyKey ? { text: storedNoteText(draft.title, draft.content), key: draft.idempotencyKey } : null,
  );
  const contentRef = useRef<HTMLTextAreaElement>(null);

  usePageTitle("New note");

  const storedTitle = normalizeUserText(title);
  const storedContent = normalizeUserText(content);
  const identity = storedNoteText(title, content);
  const hasText = storedTitle.length > 0 && storedContent.length > 0;
  const dirty = storedTitle.length > 0 || storedContent.length > 0;
  // Samples stay on offer until the person writes their own text, so they can switch between them.
  const sample = SAMPLE_NOTES.find((note) => note.title === title && note.content === content);
  const showSamples = !dirty || sample !== undefined;

  useEffect(() => {
    if (!dirty) {
      writeDraft(null);
      return;
    }
    const idempotencyKey = saveKey.current?.text === identity ? saveKey.current.key : undefined;
    writeDraft({ title, content, idempotencyKey });
  }, [title, content, dirty, identity]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || !hasText) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const attempt = saveAttemptKey(saveKey.current, title, content, newIdempotencyKey);
    saveKey.current = attempt;
    writeDraft({ title, content, idempotencyKey: attempt.key });
    try {
      const note = await api.createNote({ title, content }, attempt.key);
      writeDraft(null);
      onCreated(note);
    } catch (err) {
      savingRef.current = false;
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      contentRef.current?.focus();
    }
  }

  return (
    <form className="composer" onSubmit={submit} onKeyDown={onFormKeyDown}>
      <BackLink />
      {showSamples && (
        <SampleGallery
          current={sample}
          disabled={saving}
          onPick={(picked) => {
            setTitle(picked.title);
            setContent(picked.content);
            setError(null);
          }}
        />
      )}
      <div className="panel composer-sheet">
        <h2 className="visually-hidden">New note</h2>
        <input
          className="title-input"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(clampText(e.target.value, TITLE_MAX))}
          onKeyDown={onTitleKeyDown}
          disabled={saving}
          required
          autoFocus
          autoComplete="off"
          placeholder="Title"
        />
        <Limit length={noteLength(storedTitle)} max={TITLE_MAX} />
        <textarea
          ref={contentRef}
          aria-label="Note"
          value={content}
          onChange={(e) => setContent(clampText(e.target.value, CONTENT_MAX))}
          disabled={saving}
          rows={12}
          required
          placeholder={showSamples ? "Write your note, or pick a test sample above…" : "Write your note…"}
        />
        <Limit length={noteLength(storedContent)} max={CONTENT_MAX} />
        <AiOnSave content={storedContent} />
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="composer-bar">
          <div className="composer-actions">
            <a
              className="button button-ghost"
              href="#/"
              aria-disabled={saving || undefined}
              onClick={(event) => {
                if (saving) {
                  event.preventDefault();
                  return;
                }
                if (dirty) writeDraft(null);
              }}
            >
              {dirty ? "Discard" : "Cancel"}
            </a>
            <button type="submit" title={`${shortcut} Enter`} disabled={!hasText || saving} aria-busy={saving}>
              {saving && <span className="spinner" aria-hidden="true" />}
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
