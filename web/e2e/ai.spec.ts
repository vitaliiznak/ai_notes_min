import { expect, test } from "@playwright/test";
import { clearNotes, longNote, noteTags, saveNote, SHORT_NOTE } from "./helpers";

const LONG_NOTE = { title: "Postgres 17 upgrade", content: longNote("postgres") };

test.beforeEach(async ({ request }) => {
  await clearNotes(request);
});

test("streams the summary text before it is stored", async ({ page }) => {
  await saveNote(page, LONG_NOTE);
  await expect(noteTags(page)).toHaveCount(5);

  // Regenerating starts a fresh call, so the streaming state is on screen from the click.
  const stored = page.waitForResponse(
    (response) => response.url().endsWith("/summary?regenerate=true") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Regenerate summary" }).click();

  await expect(page.getByText("Summarizing…")).toBeVisible();
  await expect(page.locator(".summary-text.is-streaming")).toBeVisible();
  await stored;

  await expect(page.locator(".summary-text")).toContainText('[fake AI] Summary of "Postgres 17 upgrade".');
  await expect(page.getByText("Summarizing…")).toHaveCount(0);
});

test("regenerates the tags without touching the summary", async ({ page }) => {
  await saveNote(page, LONG_NOTE);
  await expect(noteTags(page)).toHaveCount(5);
  const summary = await page.locator(".summary-text").innerText();

  const stored = page.waitForResponse(
    (response) => response.url().endsWith("/tags?regenerate=true") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Regenerate tags" }).click();
  await expect(page.getByText("Tagging…")).toBeVisible();
  await stored;

  await expect(noteTags(page)).toHaveCount(5);
  await expect(page.locator(".summary-text")).toHaveText(summary);
});

const unavailable = {
  status: 502,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "ai_unavailable", message: "The AI provider failed (500)." } }),
};

test("shows what to do when regenerating tags fails, and Try again calls the model again", async ({ page }) => {
  await saveNote(page, SHORT_NOTE);
  await expect(noteTags(page)).toHaveCount(4);

  let failed = false;
  await page.route(/\/api\/notes\/[^/]+\/tags\?regenerate=true/, async (route) => {
    if (failed) return route.continue();
    failed = true;
    await route.fulfill(unavailable);
  });

  await page.getByRole("button", { name: "Regenerate tags" }).click();
  await expect(page.locator(".tags-error")).toContainText("The AI service isn't responding. Try again in a moment.");

  const retried = page.waitForResponse(
    (response) => response.url().includes("/tags?regenerate=true") && response.request().method() === "POST" && response.status() === 200,
  );
  await page.locator(".tags-error").getByRole("button", { name: "Try again" }).click();
  await retried;

  await expect(noteTags(page)).toHaveCount(4);
  await expect(page.locator(".tags-error")).toHaveCount(0);
});

test("offers Try again after a summary regenerate fails, and that retry calls the model again", async ({ page }) => {
  await saveNote(page, LONG_NOTE);
  await expect(page.locator(".summary-text")).toContainText('[fake AI] Summary of "Postgres 17 upgrade".');

  let failed = false;
  await page.route(/\/api\/notes\/[^/]+\/summary\?regenerate=true/, async (route) => {
    if (failed) return route.continue();
    failed = true;
    await route.fulfill(unavailable);
  });

  await page.getByRole("button", { name: "Regenerate summary" }).click();
  await expect(page.locator(".ai .error-banner")).toContainText("The AI service isn't responding. Try again in a moment.");

  const retried = page.waitForResponse(
    (response) =>
      response.url().includes("/summary?regenerate=true") && response.request().method() === "POST" && response.status() === 200,
  );
  await page.locator(".ai .error-banner").getByRole("button", { name: "Try again" }).click();
  await retried;

  await expect(page.locator(".summary-text")).toContainText('[fake AI] Summary of "Postgres 17 upgrade".');
  await expect(page.locator(".ai .error-banner")).toHaveCount(0);
});
