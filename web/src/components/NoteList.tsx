import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../api";
import { formatNoteTime } from "../format";
import { notesQuery } from "../queries";
import { useTagFilter } from "../tag-filter";
import { Placeholder } from "./Placeholder";
import { Tags } from "./Tags";

// The filtered-by tag goes first, so each listed note shows why it matched.
function withTagFirst(tags: string[], tag: string | null): string[] {
  return tag && tags.includes(tag) ? [tag, ...tags.filter((t) => t !== tag)] : tags;
}

// A ref callback runs when the selection moves to a link, not on a list refresh, so the reader's own
// scrolling stays. The list is hidden on narrow screens while reading.
function scrollIntoView(link: HTMLAnchorElement | null) {
  if (link && link.getClientRects().length > 0) link.scrollIntoView({ block: "nearest" });
}

export function NoteList({ selectedId }: { selectedId: string | null }) {
  const { data: notes, error, refetch } = useQuery(notesQuery);
  const { tag, show, clear } = useTagFilter();
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
          <button type="button" className="text-button" onClick={clear}>
            Show all
          </button>
        )}
      </div>
      {!notes && !error && (
        <>
          <p className="visually-hidden" role="status">
            Loading notes…
          </p>
          <Placeholder className="list-skeleton" lines={4} />
        </>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <p>{errorMessage(error)}</p>
          <button type="button" className="button-ghost" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      )}
      {notes?.length === 0 && (
        <p className="sidebar-empty">
          No notes yet. <a href="#/new">Try a sample note</a>.
        </p>
      )}
      {notes && notes.length > 0 && visible?.length === 0 && <p className="sidebar-empty">No notes tagged {tag}.</p>}
      {visible && visible.length > 0 && (
        <ul className="note-list">
          {visible.map((note) => (
            <li key={note.id}>
              <a
                href={`#/notes/${note.id}`}
                aria-current={note.id === selectedId ? "page" : undefined}
                ref={note.id === selectedId ? scrollIntoView : undefined}
              >
                <span className="note-list-title">{note.title}</span>
              </a>
              <div className="note-list-meta">
                <time dateTime={note.createdAt} title={formatNoteTime(note.createdAt, "full")}>
                  {formatNoteTime(note.createdAt, "short")}
                </time>
                {note.tags && (
                  <Tags
                    tags={withTagFirst(note.tags, tag).slice(0, 2)}
                    active={tag}
                    onSelect={(next) => (next === tag ? clear() : show(next))}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
