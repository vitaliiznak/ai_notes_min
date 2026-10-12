import { createContext, use } from "react";

/** The tag the note list is filtered by. Shared by the list and the note page, which both show tags. */
export interface TagFilter {
  tag: string | null;
  /** Filters by this tag and goes to the list. On narrow screens the list is only visible on the home view. */
  filterBy: (tag: string) => void;
  clear: () => void;
}

export const TagFilterContext = createContext<TagFilter | null>(null);

export function useTagFilter(): TagFilter {
  const filter = use(TagFilterContext);
  if (!filter) throw new Error("useTagFilter needs the TagFilterContext provider that App renders.");
  return filter;
}
