import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DeleteAllNotes } from "./components/DeleteNotes";
import { NoteIcon, PlusIcon } from "./components/icons";
import { NewNoteForm } from "./components/NewNoteForm";
import { NoteDetail } from "./components/NoteDetail";
import { NoteList } from "./components/NoteList";
import { notesQuery } from "./queries";
import { href, navigate, useHashRoute } from "./routes";
import type { NoteListItem } from "./shared";
import { TagFilterContext } from "./tag-filter";

export function App() {
  const route = useHashRoute();
  // Refetched when the tab is focused again, and after every change (see queries.ts).
  const { data: notes } = useQuery(notesQuery);
  const [tag, setTag] = useState<string | null>(null);
  const tagFilter = {
    tag,
    filterBy: (next: string) => {
      setTag(next);
      navigate(href.home);
    },
    clear: () => setTag(null),
  };

  return (
    <TagFilterContext value={tagFilter}>
      <div className={route.name === "home" ? "layout layout-home" : "layout layout-reading"}>
        <aside className="sidebar">
          <header className="sidebar-header">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                <NoteIcon />
              </span>
              <h1>AI Notes</h1>
            </div>
            <a className="button button-new" href={href.newNote} aria-current={route.name === "new" ? "page" : undefined}>
              <PlusIcon />
              New note
            </a>
          </header>
          <div className="sidebar-scroll">
            <NoteList selectedId={route.name === "note" ? route.id : null} />
          </div>
          {notes && notes.length > 0 && (
            <div className="sidebar-footer">
              <DeleteAllNotes />
            </div>
          )}
        </aside>
        <main className="main">
          {route.name === "new" && <NewNoteForm />}
          {route.name === "note" && <NoteDetail key={route.id} id={route.id} />}
          {route.name === "home" && <Home notes={notes} />}
        </main>
      </div>
    </TagFilterContext>
  );
}

// Desktop only: on narrow screens the list is the home view. Loading and errors show in the list.
function Home({ notes }: { notes: NoteListItem[] | undefined }) {
  if (!notes) return null;
  return (
    <p className="empty-state">
      {notes.length === 0 ? (
        <>No notes yet. <a href={href.newNote}>Write one, or start from a sample</a>.</>
      ) : (
        <>Pick a note from the list, or <a href={href.newNote}>write a new one</a>.</>
      )}
    </p>
  );
}
