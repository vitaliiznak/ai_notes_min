import { createContext, use } from "react";

/** The tag the note list is filtered by. Shared by the list and the note page, which both show tags. */
interface TagFilter {
  tag: string | null;
  /** Filters by this tag and goes to the list. On narrow screens the list is only visible on the home view. */
  show: (tag: string) => void;
  clear: () => void;
}

export const TagFilterContext = createContext<TagFilter>({ tag: null, show: () => {}, clear: () => {} });

export const useTagFilter = () => use(TagFilterContext);
