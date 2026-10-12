import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "new" } | { name: "note"; id: string };

/** Every hash the app links to. */
export const href = {
  home: "#/",
  newNote: "#/new",
  note: (id: string) => `#/notes/${id}`,
};

function parseRoute(hash: string): Route {
  if (hash === href.newNote) return { name: "new" };
  const match = /^#\/notes\/([^/]+)$/.exec(hash);
  return match ? { name: "note", id: match[1]! } : { name: "home" };
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useHashRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribeToHash, () => window.location.hash));
}

export function navigate(to: string): void {
  window.location.hash = to;
}
