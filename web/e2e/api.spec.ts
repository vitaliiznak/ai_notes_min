import { expect, test } from "@playwright/test";

test("opens the OpenAPI reference from the sidebar", async ({ page }) => {
  await page.goto("/#/");
  await page.getByRole("link", { name: "API reference" }).click();

  await expect(page).toHaveURL(/#\/api/);
  await expect(page.getByRole("link", { name: "Notes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Database health" })).toBeVisible({ timeout: 15_000 });
});
