import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type NoteListItem } from "./api";
import { NewNoteForm } from "./components/NewNoteForm";
import { NoteDetail } from "./components/NoteDetail";
import { DeleteNotes } from "./components/DeleteNotes";
import { NoteList } from "./components/NoteList";

const ApiReference = lazy(() => import("./components/ApiReference").then((m) => ({ default: m.ApiReference })));

type Route = { name: "home" } | { name: "new" } | { name: "note"; id: string } | { name: "api" };

function parseRoute(hash: string): Route {
  if (hash === "#/new") return { name: "new" };
  if (hash === "#/api" || hash.startsWith("#/api/")) return { name: "api" };
  const match = /^#\/notes\/([^/]+)$/.exec(hash);
  return match ? { name: "note", id: match[1]! } : { name: "home" };
}

function useHashRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}

export function App() {
  const route = useHashRoute();
  const [notes, setNotes] = useState<NoteListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const listRequest = useRef(0);
  const sidebarRef = useRef<HTMLElement>(null);

  const refreshList = useCallback(() => {
    const requestId = ++listRequest.current;
    api.listNotes().then(
      (next) => {
        if (requestId !== listRequest.current) return;
        setNotes(next);
        setListError(null);
      },
      (err) => {
        if (requestId !== listRequest.current) return;
        setListError(errorMessage(err));
      },
    );
  }, []);
  useEffect(refreshList, [refreshList]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshList();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshList]);

  function showTag(next: string) {
    setTag(next);
    // On narrow screens the list is hidden while reading a note, so go to it.
    if (sidebarRef.current?.getClientRects().length === 0) window.location.hash = "#/";
  }

  if (route.name === "api") {
    return (
      <div className="api-page">
        <header className="api-page-bar">
          <a href="#/">Notes</a>
        </header>
        <div className="api-page-frame">
          <Suspense fallback={<p className="api-page-loading">Loading the API reference…</p>}>
            <ApiReference />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className={route.name === "home" ? "layout layout-home" : "layout layout-reading"}>
      <aside className="sidebar" ref={sidebarRef}>
        <header className="sidebar-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18">
                <path
                  d="M4.25 2.75h6.4l3.1 3.1v9.4h-9.5v-12.5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path d="M10.4 2.9v3.3h3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            <h1>AI Notes</h1>
          </div>
          <a
            className="button button-new"
            href="#/new"
            aria-current={route.name === "new" ? "page" : undefined}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
            New note
          </a>
          <a className="api-link" href="#/api">API reference</a>
        </header>
        <div className="sidebar-scroll">
          <NoteList
            notes={notes}
            error={listError}
            selectedId={route.name === "note" ? route.id : null}
            onRetry={refreshList}
            tag={tag}
            onSelectTag={showTag}
            onClearTag={() => setTag(null)}
          />
        </div>
        {notes && notes.length > 0 && <div className="sidebar-footer"><DeleteNotes onDeleted={() => {
          ++listRequest.current;
          setNotes([]);
          setTag(null);
          window.location.hash = "#/";
          refreshList();
        }} /></div>}
      </aside>
      <main className="main">
        {route.name === "new" && (
          <NewNoteForm
            onCreated={(note) => {
              setTag(null);
              refreshList();
              window.location.hash = `#/notes/${note.id}`;
            }}
          />
        )}
        {route.name === "note" && (
          <NoteDetail
            key={route.id}
            id={route.id}
            onChanged={refreshList}
            onDeleted={() => { refreshList(); window.location.hash = "#/"; }}
            activeTag={tag}
            onSelectTag={showTag}
            onClearTag={() => setTag(null)}
          />
        )}
        {route.name === "home" && <Home notes={notes} />}
      </main>
    </div>
  );
}

// Desktop only: on narrow screens the list is the home view. Loading and errors show in the list.
function Home({ notes }: { notes: NoteListItem[] | null }) {
  if (!notes) return null;
  if (notes.length === 0) {
    return (
      <p className="empty-state">
        No notes yet. <a href="#/new">Write one, or start from a sample</a>.
      </p>
    );
  }
  return (
    <p className="empty-state">
      Pick a note from the list, or <a href="#/new">write a new one</a>.
    </p>
  );
}
