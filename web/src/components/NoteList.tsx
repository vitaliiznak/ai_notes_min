import { useEffect, useRef } from "react";
import type { NoteListItem } from "../api";
import { formatNoteTime } from "../format";
import { Tags } from "./Tags";

interface Props {
  notes: NoteListItem[] | null;
  error: string | null;
  selectedId: string | null;
  onRetry: () => void;
  /** When set, only notes with this tag are listed. */
  tag: string | null;
  onSelectTag: (tag: string) => void;
  onClearTag: () => void;
}

// The filtered-by tag goes first, so each listed note shows why it matched.
function withTagFirst(tags: string[], tag: string | null): string[] {
  return tag && tags.includes(tag) ? [tag, ...tags.filter((t) => t !== tag)] : tags;
}

export function NoteList({ notes, error, selectedId, onRetry, tag, onSelectTag, onClearTag }: Props) {
  const selectedRef = useRef<HTMLAnchorElement>(null);
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId || scrolledFor.current === selectedId) return;
    const el = selectedRef.current;
    const container = el?.closest(".sidebar-scroll");
    if (!el || !(container instanceof HTMLElement)) return;
    const elRect = el.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (cRect.height === 0) return;
    scrolledFor.current = selectedId;
    if (elRect.top >= cRect.top && elRect.bottom <= cRect.bottom) return;
    container.scrollTop += elRect.top - cRect.top - (cRect.height - elRect.height) / 2;
  }, [selectedId, notes, tag]);

  const alert = error ? (
    <div className="error-banner" role="alert">
      <p>{error}</p>
      <button type="button" className="button-ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  ) : null;
  const visible = notes && tag ? notes.filter((note) => note.tags?.includes(tag)) : notes;

  return (
    <>
      <div className="list-label">
        <h2>
          {tag ? (
            <>
              Tagged <span className="filter-tag">{tag}</span>
            </>
          ) : (
            "Notes"
          )}
        </h2>
        {tag && (
          <button type="button" className="text-button" onClick={onClearTag}>
            Show all
          </button>
        )}
      </div>
      {!notes && !error && (
        <>
          <p className="visually-hidden" role="status">
            Loading notes…
          </p>
          <div className="skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </>
      )}
      {!notes && error && alert}
      {notes && alert}
      {notes && notes.length === 0 && (
        <p className="sidebar-empty">
          No notes yet. <a href="#/new">Try a sample note</a>.
        </p>
      )}
      {notes && notes.length > 0 && visible?.length === 0 && (
        <p className="sidebar-empty">No notes tagged {tag}.</p>
      )}
      {visible && visible.length > 0 && (
        <ul className="note-list">
          {visible.map((note) => (
            <li key={note.id}>
              <a
                href={`#/notes/${note.id}`}
                aria-current={note.id === selectedId ? "page" : undefined}
                ref={note.id === selectedId ? selectedRef : undefined}
              >
                <span className="note-list-title">{note.title}</span>
                <span className="note-list-meta">
                  <time dateTime={note.createdAt} title={formatNoteTime(note.createdAt, "full")}>
                    {formatNoteTime(note.createdAt, "short")}
                  </time>
                  {note.tags && (
                    <Tags
                      tags={withTagFirst(note.tags, tag).slice(0, 2)}
                      active={tag}
                      onSelect={(next) => (next === tag ? onClearTag() : onSelectTag(next))}
                    />
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
