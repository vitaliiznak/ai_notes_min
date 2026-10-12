import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, canSummarize, errorMessage, SUMMARY_MIN_CONTENT, type AiField, type AiPreview, type Note } from "../api";
import { formatNoteTime } from "../format";
import { noteQuery } from "../queries";
import { useTagFilter } from "../tag-filter";
import { BackLink } from "./BackLink";
import { DeleteNotes } from "./DeleteNotes";
import { RefreshIcon, Sparkle } from "./icons";
import { Placeholder } from "./Placeholder";
import { Tags } from "./Tags";

// Moves focus to the heading once the note is shown, so a screen reader starts there.
const focus = (heading: HTMLHeadingElement | null) => heading?.focus();

export function NoteDetail({ id }: { id: string }) {
  const { data: note, error, isPending, isFetching, refetch } = useQuery(noteQuery(id));

  if (isPending || error) {
    return (
      <div className="read">
        <BackLink />
        {isPending ? (
          <>
            <p className="visually-hidden" role="status">
              Loading note…
            </p>
            <Placeholder className="panel note note-skeleton" />
          </>
        ) : (
          <div className="panel note-status">
            <p className="error-banner" role="alert">
              {errorMessage(error)}
            </p>
            <button type="button" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
      </div>
    );
  }

  const summarized = canSummarize(note.content);

  return (
    <div className="read">
      <title>{`${note.title} · AI Notes`}</title>
      <BackLink />
      <article className="panel note">
        <header className="note-header">
          <h2 ref={focus} tabIndex={-1}>
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
          <TagsRow note={note} />
        </header>
        {summarized && <SummaryCard note={note} />}
        <div className="note-body">
          <h3 className="visually-hidden">Note</h3>
          <div className="note-content">{note.content}</div>
        </div>
        <DeleteNotes id={id} />
      </article>
    </div>
  );
}

/**
 * One AI result for this note. A missing one is requested on mount: for a new note the
 * server is already generating it, so the request joins that call and streams its text.
 * Regenerate and Try again only show while nothing is running, so runs never overlap.
 */
function useAiResult(note: Note, field: AiField) {
  const queryClient = useQueryClient();
  const tagFilter = useTagFilter();
  // The text so far, while the model writes it.
  const [draft, setDraft] = useState<AiPreview | null>(null);
  const generate = useMutation({
    mutationFn: (regenerate: boolean) => api.generate(note.id, field, regenerate, setDraft),
    // Also after the reader has gone back to the list: the cache and the sidebar still take it.
    onSuccess: (next) => {
      // A filter by a tag the note no longer has would hide the note being read.
      const { tag } = tagFilter;
      if (field === "tags" && tag && note.tags?.includes(tag) && !next.tags?.includes(tag)) tagFilter.clear();
      // Summary and tags finish independently. Take only this field, so a slower response
      // carrying the other field's older value can't erase it.
      queryClient.setQueryData(noteQuery(note.id).queryKey, (current) => ({ ...(current ?? next), [field]: next[field] }));
    },
    onSettled: () => setDraft(null),
  });
  const missing = note[field] === null;

  // Once per note (NoteDetail is keyed by note id). Leaving the page keeps the request open.
  useEffect(() => {
    if (missing) generate.mutate(false);
  }, []);

  return {
    // Busy from the first paint when missing, before the effect has started the request.
    pending: generate.isPending || (missing && generate.isIdle),
    error: generate.error ? errorMessage(generate.error) : null,
    draft,
    // Announces a new result to screen readers.
    status: generate.isSuccess ? "status" : undefined,
    hasResult: !missing,
    run: (regenerate: boolean) => generate.mutate(regenerate),
  };
}

type AiResult = ReturnType<typeof useAiResult>;

// The run in progress, or, once there is a result, a button to run it again.
function AiAction({ ai, working, regenerate }: { ai: AiResult; working: string; regenerate: string }) {
  if (ai.pending) {
    return (
      <span className="ai-status">
        <span className="spinner" aria-hidden="true" />
        {working}
      </span>
    );
  }
  return (
    ai.hasResult && (
      <button type="button" className="icon-button" onClick={() => ai.run(true)} aria-label={regenerate} title={regenerate}>
        <RefreshIcon />
      </button>
    )
  );
}

function AiError({ ai }: { ai: AiResult }) {
  return (
    ai.error && (
      <div className="error-banner" role="alert">
        <p>{ai.error}</p>
        <button type="button" className="button-ghost" onClick={() => ai.run(ai.hasResult)}>
          Try again
        </button>
      </div>
    )
  );
}

// Tags sit under the date as a light row: they are labels for the note, not a section of it.
function TagsRow({ note }: { note: Note }) {
  const { tag: activeTag, show } = useTagFilter();
  const ai = useAiResult(note, "tags");
  const tags = ai.draft?.tags ?? note.tags ?? [];
  const streaming = ai.draft !== null;

  return (
    <div className="note-tags" aria-busy={ai.pending} role={ai.status}>
      <Sparkle />
      {tags.length > 0 ? (
        <Tags tags={tags} active={streaming ? null : activeTag} onSelect={streaming ? undefined : show} />
      ) : (
        ai.pending && <Placeholder className="tag-skeleton" />
      )}
      <AiAction ai={ai} working="Tagging…" regenerate="Regenerate tags" />
      <AiError ai={ai} />
    </div>
  );
}

function SummaryCard({ note }: { note: Note }) {
  const ai = useAiResult(note, "summary");
  const text = ai.draft?.summary ?? note.summary;
  const streaming = ai.draft !== null;

  return (
    <section className="ai" aria-busy={ai.pending}>
      <div className="ai-head">
        <h3>
          <Sparkle /> Summary
        </h3>
        <AiAction ai={ai} working="Summarizing…" regenerate="Regenerate summary" />
      </div>
      {text !== null ? (
        <p className={streaming ? "summary-text is-streaming" : "summary-text"} role={ai.status}>
          {text}
        </p>
      ) : (
        ai.pending && <Placeholder className="ai-skeleton" />
      )}
      <AiError ai={ai} />
    </section>
  );
}
