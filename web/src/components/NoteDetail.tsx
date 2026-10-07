import { useEffect, useRef, useState } from "react";
import { api, canSummarize, errorMessage, SUMMARY_MIN_CONTENT, type AiField, type AiPreview, type Note } from "../api";
import { usePageTitle } from "../browser";
import { formatNoteTime } from "../format";
import { BackLink } from "./BackLink";
import { Sparkle } from "./Sparkle";
import { DeleteNotes } from "./DeleteNotes";
import { Tags } from "./Tags";

export function NoteDetail({
  id,
  onChanged,
  onDeleted,
  activeTag,
  onSelectTag,
  onClearTag,
}: {
  id: string;
  onChanged: () => void;
  onDeleted: () => void;
  activeTag: string | null;
  onSelectTag: (tag: string) => void;
  onClearTag: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getNote(id).then(
      (next) => {
        if (!active) return;
        setNote(next);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [id, attempt]);

  usePageTitle(note?.title);

  useEffect(() => {
    headingRef.current?.focus();
  }, [note?.id]);

  if (!note && loading) {
    return (
      <div className="read">
        <BackLink />
        <p className="visually-hidden" role="status">
          Loading note…
        </p>
        <div className="panel note note-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  if (error || !note) {
    return (
      <div className="read">
        <BackLink />
        <div className="panel note-status">
          <p className="error-banner" role="alert">
            {error ?? "Note not found."}
          </p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  const summarized = canSummarize(note.content);

  // Summary and tags finish independently. Take only this field, so a slower response
  // carrying the other field's older value can't erase it.
  const update = (field: AiField, next: Note) => {
    if (field === "tags" && activeTag && note.tags?.includes(activeTag) && !next.tags?.includes(activeTag)) onClearTag();
    setNote((current) => {
      if (!current) return next;
      return field === "summary" ? { ...current, summary: next.summary } : { ...current, tags: next.tags };
    });
    onChanged();
  };

  return (
    <div className="read">
      <BackLink />
      <article className="panel note">
        <header className="note-header">
          <h2 ref={headingRef} tabIndex={-1}>
            {note.title}
          </h2>
          <p className="note-meta">
            <time className="nowrap" dateTime={note.createdAt}>
              {formatNoteTime(note.createdAt, "full")}
            </time>
            {!summarized && (
              <>
                {" "}
                <span className="nowrap">· No summary under {SUMMARY_MIN_CONTENT} characters</span>
              </>
            )}
          </p>
          <TagsRow note={note} onUpdated={update} onLeft={onChanged} activeTag={activeTag} onSelectTag={onSelectTag} />
        </header>
        {summarized && <SummaryCard note={note} onUpdated={update} onLeft={onChanged} />}
        <div className="note-body">
          <h3 className="visually-hidden">Note</h3>
          <div className="note-content">{note.content}</div>
        </div>
        <DeleteNotes id={id} onDeleted={onDeleted} />
      </article>
    </div>
  );
}

/**
 * One AI result for this note. A missing one is requested on mount: for a new note the
 * server is already generating it, so the request joins that call and streams its text.
 */
function useAiResult(
  note: Note,
  field: AiField,
  onUpdated: (field: AiField, note: Note) => void,
  onLeft: () => void,
) {
  const missing = note[field] === null;
  // Starts busy when missing, so the first paint is the loading state rather than an empty one.
  const [pending, setPending] = useState(missing);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  const [draft, setDraft] = useState<AiPreview | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  async function run(regenerate: boolean) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError(null);
    setDraft(null);
    setAnnounce(false);
    try {
      const next = await api.generate(
        note.id,
        field,
        regenerate,
        (preview) => {
          if (!abort.signal.aborted && mounted.current) setDraft(preview);
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      if (!mounted.current) {
        onLeft();
        return;
      }
      onUpdated(field, next);
      setAnnounce(true);
    } catch (err) {
      if (abort.signal.aborted || !mounted.current) return;
      setError(errorMessage(err));
    } finally {
      if (!abort.signal.aborted && mounted.current) {
        setDraft(null);
        setPending(false);
      }
    }
  }

  // Once per note (NoteDetail is keyed by note id). Leaving the page keeps the request open so the
  // sidebar can pick up tags the server stores after the reader has gone back to the list.
  useEffect(() => {
    mounted.current = true;
    if (missing) void run(false);
    return () => {
      mounted.current = false;
    };
  }, []);

  return { pending, error, draft, status: announce ? "status" : undefined, hasResult: note[field] !== null, run };
}

// Tags sit under the date as a light row: they are labels for the note, not a section of it.
function TagsRow({
  note,
  onUpdated,
  onLeft,
  activeTag,
  onSelectTag,
}: {
  note: Note;
  onUpdated: (field: AiField, note: Note) => void;
  onLeft: () => void;
  activeTag: string | null;
  onSelectTag: (tag: string) => void;
}) {
  const { pending, error, draft, status, hasResult, run } = useAiResult(note, "tags", onUpdated, onLeft);
  const tags = (draft && "tags" in draft ? draft.tags : null) ?? note.tags ?? [];
  const streaming = pending && draft !== null;

  return (
    <div className="note-tags" aria-busy={pending} role={status}>
      <Sparkle />
      {tags.length > 0 ? (
        <Tags tags={tags} active={streaming ? null : activeTag} onSelect={streaming ? undefined : onSelectTag} />
      ) : (
        pending && (
          <span className="tag-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )
      )}
      {pending ? (
        <span className="ai-status">
          <span className="spinner" aria-hidden="true" />
          Tagging…
        </span>
      ) : (
        hasResult && (
          <button type="button" className="icon-button" onClick={() => run(true)} aria-label="Regenerate tags" title="Regenerate tags">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13 8a5 5 0 1 1-1.46-3.54M13 2.75v2.5h-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )
      )}
      {error && (
        <p className="tags-error" role="alert">
          {error}{" "}
          <button type="button" className="text-button" onClick={() => run(hasResult)}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

function SummaryCard({
  note,
  onUpdated,
  onLeft,
}: {
  note: Note;
  onUpdated: (field: AiField, note: Note) => void;
  onLeft: () => void;
}) {
  const { pending, error, draft, status, hasResult, run } = useAiResult(note, "summary", onUpdated, onLeft);
  const text = (draft && "summary" in draft ? draft.summary : null) ?? note.summary;
  const streaming = pending && draft !== null;

  return (
    <section className="ai" aria-busy={pending}>
      <div className="ai-head">
        <h3>
          <Sparkle /> Summary
        </h3>
        {pending ? (
          <span className="ai-status">
            <span className="spinner" aria-hidden="true" />
            Summarizing…
          </span>
        ) : (
          hasResult && (
            <button type="button" className="text-button" onClick={() => run(true)} aria-label="Regenerate summary">
              Regenerate
            </button>
          )
        )}
      </div>
      {text !== null ? (
        <p className={streaming ? "summary-text is-streaming" : "summary-text"} role={status}>
          {text}
        </p>
      ) : (
        pending && (
          <div className="ai-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )
      )}
      {error && (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          <button type="button" className="button-ghost" onClick={() => run(hasResult)}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
