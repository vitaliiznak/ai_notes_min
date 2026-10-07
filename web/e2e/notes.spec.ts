import { expect, test } from "@playwright/test";
import { clearNotes, longNote, noteTags, saveNote, SHORT_NOTE } from "./helpers";

const LONG_NOTE = { title: "Postgres 17 upgrade", content: longNote("postgres") };

test.beforeEach(async ({ request }) => {
  await clearNotes(request);
});

test("saves a long note, then shows the tags and summary it generated", async ({ page }) => {
  await saveNote(page, LONG_NOTE);

  await expect(page.locator(".summary-text")).toContainText('[fake AI] Summary of "Postgres 17 upgrade".');
  await expect(noteTags(page)).toHaveCount(5);
  await expect(noteTags(page).first()).toHaveText("postgres");

  // Both results are stored, so reopening the note neither asks the model again nor shows a loading state.
  await page.reload();
  await expect(page.locator(".summary-text")).toContainText('[fake AI] Summary of "Postgres 17 upgrade".');
  await expect(noteTags(page)).toHaveCount(5);
  await expect(page.getByText("Summarizing…")).toHaveCount(0);
  await expect(page.getByText("Tagging…")).toHaveCount(0);
});

test("saves a short note, which gets tags only, and says why", async ({ page }) => {
  await saveNote(page, SHORT_NOTE);

  await expect(noteTags(page)).toHaveCount(4);
  await expect(noteTags(page).filter({ hasText: "milk" })).toHaveCount(1);
  await expect(page.getByText("No summary under 500 characters")).toBeVisible();
  await expect(page.locator(".summary-text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate summary" })).toHaveCount(0);
});

test("lists the note in the sidebar and opens it from there", async ({ page }) => {
  await saveNote(page, SHORT_NOTE);
  await expect(noteTags(page)).toHaveCount(4);

  await page.goto("/#/");
  const link = page.locator(".note-list a").filter({ hasText: SHORT_NOTE.title });
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page.getByRole("heading", { name: SHORT_NOTE.title })).toBeVisible();
  await expect(page.locator(".note-content")).toHaveText(SHORT_NOTE.content);
});

test("filters the list by a tag picked on the note page", async ({ page }) => {
  await saveNote(page, LONG_NOTE);
  await expect(noteTags(page)).toHaveCount(5);
  await saveNote(page, { title: "Kitchen rebuild", content: longNote("kitchen") });
  await expect(noteTags(page)).toHaveCount(5);

  await page.locator(".note-list a").filter({ hasText: LONG_NOTE.title }).click();
  await page.locator(".note-tags").getByRole("button", { name: "postgres" }).click();

  await expect(page.locator(".list-label")).toContainText("Tagged postgres");
  await expect(page.locator(".note-list a")).toHaveCount(1);
  await expect(page.locator(".note-list a")).toContainText(LONG_NOTE.title);

  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.locator(".note-list a")).toHaveCount(2);
});

test("keeps an unsaved draft across a reload", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByLabel("Title").fill("Half-written note");
  await page.getByLabel("Note").fill("Picks up where I left off.");

  await page.reload();

  await expect(page.getByLabel("Title")).toHaveValue("Half-written note");
  await expect(page.getByLabel("Note")).toHaveValue("Picks up where I left off.");
});
