import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** 500+ characters, with `word` as the most frequent one, so the fake provider's first tag is that word. */
export function longNote(word: string): string {
  const sentence = `The ${word} plan is the ${word} plan: Dana owns the ${word} runbook and Sam is on call for ${word} questions.`;
  return Array.from({ length: 5 }, () => sentence).join(" ");
}

export const SHORT_NOTE = { title: "Shopping list", content: "Buy milk and bread." };

/** Empties the shared notebook, so each spec starts from a known list. */
export async function clearNotes(request: APIRequestContext): Promise<void> {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is not set.");
  // This client is not a browser, so it has to send the Origin a mutation requires.
  const response = await request.delete("/api/notes", { headers: { origin: new URL(baseURL).origin } });
  expect(response.status()).toBe(200);
}

/** Saves a note through the composer and waits for the note page it opens. */
export async function saveNote(page: Page, note: { title: string; content: string }): Promise<void> {
  await page.goto("/#/new");
  await page.getByLabel("Title").fill(note.title);
  await page.getByLabel("Note").fill(note.content);
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page).toHaveURL(/#\/notes\/[0-9a-f-]{36}$/);
}

/** The tag buttons on the open note. They become buttons once the streamed tags are stored. */
export const noteTags = (page: Page) => page.locator(".note-tags .tag-button");
