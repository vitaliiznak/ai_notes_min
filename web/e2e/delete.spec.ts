import { expect, test } from "@playwright/test";
import { clearNotes, noteTags, saveNote, SHORT_NOTE } from "./helpers";

test.beforeEach(async ({ request }) => {
  await clearNotes(request);
});

test("deletes one note after confirming, and returns to the list", async ({ page }) => {
  await saveNote(page, SHORT_NOTE);
  await expect(noteTags(page)).toHaveCount(4);

  await page.locator(".note").getByRole("button", { name: "Delete note" }).click();
  await page.getByRole("group", { name: "Delete note" }).getByRole("button", { name: "Delete note" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".note-list a")).toHaveCount(0);
  await expect(page.locator(".sidebar-empty")).toContainText("No notes yet.");
});

test("deletes every note, but only once DELETE is typed", async ({ page }) => {
  await saveNote(page, SHORT_NOTE);
  await saveNote(page, { title: "Second note", content: "Call the plumber." });
  await page.goto("/#/");
  await expect(page.locator(".note-list a")).toHaveCount(2);

  await page.locator(".sidebar-footer").getByRole("button", { name: "Delete all notes" }).click();
  const confirmation = page.getByRole("group", { name: "Delete all notes" });
  const confirm = confirmation.getByRole("button", { name: "Delete all notes" });
  await expect(confirm).toBeDisabled();

  await confirmation.getByLabel("Type DELETE to confirm").fill("delete");
  await expect(confirm).toBeDisabled();

  await confirmation.getByLabel("Type DELETE to confirm").fill("DELETE");
  await confirm.click();

  await expect(page.locator(".note-list a")).toHaveCount(0);
  await expect(page.locator(".sidebar-empty")).toContainText("No notes yet.");
});
