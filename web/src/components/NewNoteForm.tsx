import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
// v4 falls back to getRandomValues where crypto.randomUUID is missing: it needs HTTPS, and the cluster deploy is plain HTTP.
import { v4 as newIdempotencyKey } from "uuid";
import { api, canSummarize, charLength, errorMessage, normalizeUserText, SUMMARY_MIN_CONTENT } from "../api";
import { noteQuery } from "../queries";
import { useTagFilter } from "../tag-filter";
import { BackLink } from "./BackLink";
import { Sparkle } from "./icons";
import { SAMPLE_NOTES, SampleGallery } from "./SampleNotes";

interface Draft {
  title: string;
  content: string;
  /**
   * Sent with every save of this text, so a retry or a second submit does not store the note twice.
   * Replaced when the text changes.
   */
  idempotencyKey: string;
}

// Says before saving what the AI will do with this note, so a missing summary is never a surprise.
function AiOnSave({ content }: { content: string }) {
  const length = charLength(content);
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

export function NewNoteForm() {
  const [draft, setDraft] = useState<Draft>(() => ({ title: "", content: "", idempotencyKey: newIdempotencyKey() }));
  const { title, content } = draft;
  const queryClient = useQueryClient();
  const { clear: clearTag } = useTagFilter();
  const create = useMutation({
    mutationFn: ({ title, content, idempotencyKey }: Draft) => api.createNote({ title, content }, idempotencyKey),
    onSuccess: (note) => {
      queryClient.setQueryData(noteQuery(note.id).queryKey, note);
      clearTag();
      window.location.hash = `#/notes/${note.id}`;
    },
  });
  const saving = create.isPending;

  const storedTitle = normalizeUserText(title);
  const storedContent = normalizeUserText(content);
  const hasText = storedTitle.length > 0 && storedContent.length > 0;
  const dirty = storedTitle.length > 0 || storedContent.length > 0;
  // Samples stay on offer until the person writes their own text, so they can switch between them.
  const sample = SAMPLE_NOTES.find((note) => note.title === title && note.content === content);
  const showSamples = !dirty || sample !== undefined;

  // New text is a new note, so it gets a new key.
  const edit = (text: Partial<Pick<Draft, "title" | "content">>) =>
    setDraft((current) => ({ ...current, ...text, idempotencyKey: newIdempotencyKey() }));

  function submit(event: FormEvent) {
    event.preventDefault();
    // A second submit before this render sends the same key, so the server stores one note.
    if (hasText && !saving) create.mutate(draft);
  }

  return (
    <form className="composer" onSubmit={submit}>
      <title>New note · AI Notes</title>
      <BackLink />
      {showSamples && (
        <SampleGallery
          current={sample}
          disabled={saving}
          onPick={(picked) => {
            edit({ title: picked.title, content: picked.content });
            create.reset();
          }}
        />
      )}
      <div className="panel composer-sheet">
        <h2 className="visually-hidden">New note</h2>
        <input
          className="title-input"
          aria-label="Title"
          value={title}
          onChange={(e) => edit({ title: e.target.value })}
          disabled={saving}
          required
          autoFocus
          autoComplete="off"
          placeholder="Title"
        />
        <textarea
          aria-label="Note"
          value={content}
          onChange={(e) => edit({ content: e.target.value })}
          disabled={saving}
          rows={12}
          required
          placeholder={showSamples ? "Write your note, or pick a test sample above…" : "Write your note…"}
        />
        <AiOnSave content={storedContent} />
        {create.error && (
          <p className="error-banner" role="alert">
            {errorMessage(create.error)}
          </p>
        )}
        <div className="composer-actions">
          <a className="button button-ghost" href="#/" aria-disabled={saving || undefined}>
            {dirty ? "Discard" : "Cancel"}
          </a>
          <button type="submit" disabled={!hasText || saving} aria-busy={saving}>
            {saving && <span className="spinner" aria-hidden="true" />}
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </form>
  );
}
