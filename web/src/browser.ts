import { useEffect } from "react";

// localStorage throws in some private windows. Callers keep working without it.
function quietly<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function readStorage(key: string): string | null {
  return quietly(() => localStorage.getItem(key), null);
}

export function writeStorage(key: string, value: string | null): void {
  quietly(() => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return null;
  }, null);
}

const APP_TITLE = "AI Notes";

export function usePageTitle(page: string | undefined) {
  useEffect(() => {
    if (!page) return;
    document.title = `${page} · ${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [page]);
}
