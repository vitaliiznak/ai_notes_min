import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { formatNoteTime } from "../format";
import { noteQuery } from "../queries";
import { canSummarize, SUMMARY_MIN_CONTENT, type AiField, type AiPreview, type Note } from "../shared";
import { useTagFilter } from "../tag-filter";
import { BackLink } from "./BackLink";
import { DeleteNote } from "./DeleteNotes";
import { RefreshIcon, Sparkle } from "./icons";
import { Skeleton } from "./Skeleton";
import { Tags } from "./Tags";

// Moves focus to the heading once the note is shown, so a screen reader starts there.
const focusOnMount = (heading: HTMLHeadingElement | null) => heading?.focus();

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
            <Skeleton className="panel note note-skeleton" />
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

  const summarizable = canSummarize(note.content);

  return (
    <div className="read">
      <title>{`${note.title} · AI Notes`}</title>
      <BackLink />
      <article className="panel note">
        <header className="note-header">
          <h2 ref={focusOnMount} tabIndex={-1}>
            {note.title}
          </h2>
          <p className="note-meta">
            <time className="nowrap" dateTime={note.createdAt}>
              {formatNoteTime(note.createdAt, "full")}
            </time>
            {!summarizable && (
              <>
                {" "}
                <span className="nowrap">· No summary under {SUMMARY_MIN_CONTENT} characters</span>
              </>
            )}
          </p>
          <TagsRow note={note} />
        </header>
        {summarizable && <SummaryCard note={note} />}
        <div className="note-body">
          <h3 className="visually-hidden">Note</h3>
          <div className="note-content">{note.content}</div>
        </div>
        <DeleteNote id={id} />
      </article>
    </div>
  );
}

/**
 * One AI field of this note. A missing one is requested on mount: for a new note the
 * server is already generating it, so the request joins that call and streams its text.
 * Regenerate and Try again only show while nothing is running, so calls never overlap.
 */
function useAiField(note: Note, field: AiField) {
  const queryClient = useQueryClient();
  const tagFilter = useTagFilter();
  // The field so far, while the model writes it.
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const generate = useMutation({
    mutationFn: (regenerate: boolean) => api.generate(note.id, field, { regenerate, onPreview: setPreview }),
    // Also after the reader has gone back to the list: the cache and the sidebar still take it.
    onSuccess: (result) => {
      // A filter by a tag the note no longer has would hide the note being read.
      const { tag } = tagFilter;
      if ("tags" in result && tag && note.tags?.includes(tag) && !result.tags.includes(tag)) tagFilter.clear();
      // The result is this field alone. With no cached note there is nothing to merge it into; the next read gets the row.
      queryClient.setQueryData(noteQuery(note.id).queryKey, (current) => current && { ...current, ...result });
    },
    onSettled: () => setPreview(null),
  });
  const missing = note[field] === null;

  // Once per note (NoteDetail is keyed by note id). Leaving the page keeps the request open.
  useEffect(() => {
    if (missing) generate.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generate is a new object each render; missing flips when the result lands
  }, []);

  return {
    // Busy from the first paint when missing, before the effect has started the request.
    pending: generate.isPending || (missing && generate.isIdle),
    error: generate.error ? errorMessage(generate.error) : null,
    preview,
    // The role that announces a new result to screen readers.
    liveRole: generate.isSuccess ? "status" : undefined,
    hasResult: !missing,
    regenerate: () => generate.mutate(true),
    // Repeats what failed: a regenerate when there was a result, else the first generate.
    retry: () => generate.mutate(!missing),
  };
}

type AiFieldState = ReturnType<typeof useAiField>;

// The call in progress, or, once there is a result, a button to regenerate it.
function AiAction({ ai, workingLabel, regenerateLabel }: { ai: AiFieldState; workingLabel: string; regenerateLabel: string }) {
  if (ai.pending) {
    return (
      <span className="ai-status">
        <span className="spinner" aria-hidden="true" />
        {workingLabel}
      </span>
    );
  }
  return (
    ai.hasResult && (
      <button type="button" className="icon-button" onClick={ai.regenerate} aria-label={regenerateLabel} title={regenerateLabel}>
        <RefreshIcon />
      </button>
    )
  );
}

function AiErrorBanner({ ai }: { ai: AiFieldState }) {
  return (
    ai.error && (
      <div className="error-banner" role="alert">
        <p>{ai.error}</p>
        <button type="button" className="button-ghost" onClick={ai.retry}>
          Try again
        </button>
      </div>
    )
  );
}

// Tags sit under the date as a light row: they are labels for the note, not a section of it.
function TagsRow({ note }: { note: Note }) {
  const { tag: activeTag, filterBy } = useTagFilter();
  const ai = useAiField(note, "tags");
  const tags = ai.preview?.tags ?? note.tags ?? [];
  const streaming = ai.preview !== null;

  return (
    <div className="note-tags" aria-busy={ai.pending} role={ai.liveRole}>
      <Sparkle />
      {tags.length > 0 ? (
        <Tags tags={tags} active={streaming ? null : activeTag} onSelect={streaming ? undefined : filterBy} />
      ) : (
        ai.pending && <Skeleton className="tag-skeleton" />
      )}
      <AiAction ai={ai} workingLabel="Tagging…" regenerateLabel="Regenerate tags" />
      <AiErrorBanner ai={ai} />
    </div>
  );
}

function SummaryCard({ note }: { note: Note }) {
  const ai = useAiField(note, "summary");
  const text = ai.preview?.summary ?? note.summary;
  const streaming = ai.preview !== null;

  return (
    <section className="ai" aria-busy={ai.pending}>
      <div className="ai-head">
        <h3>
          <Sparkle /> Summary
        </h3>
        <AiAction ai={ai} workingLabel="Summarizing…" regenerateLabel="Regenerate summary" />
      </div>
      {text !== null ? (
        <p className={streaming ? "summary-text is-streaming" : "summary-text"} role={ai.liveRole}>
          {text}
        </p>
      ) : (
        ai.pending && <Skeleton className="ai-skeleton" />
      )}
      <AiErrorBanner ai={ai} />
    </section>
  );
}
