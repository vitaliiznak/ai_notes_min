// Notes as the API returns them. The web client imports these types too.

export interface Note {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[] | null;
  createdAt: string;
}

export type NoteListItem = Pick<Note, "id" | "title" | "tags" | "createdAt">;

/** The AI results a note can carry; also the column names that store them. */
export type AiField = "summary" | "tags";

/** A summary or tag list as shown while the model is still writing it. A preview carries one of the two. */
export type AiPreview = { summary?: string; tags?: string[] };
