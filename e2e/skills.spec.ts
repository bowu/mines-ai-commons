import { expect, test } from "@playwright/test";
import { acceptNextDialog, cleanupE2ESkills, e2eName } from "./helpers";

test.describe("skills page", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupE2ESkills(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2ESkills(request);
  });

  test("creates, updates, searches, and deletes a skill", async ({ page }) => {
    const skillName = e2eName("Skill CRUD");
    const updatedInstructions =
      "1. Gather context\n2. Compare options\n3. Return concise answer";

    await page.goto("/skills");
    await page.getByRole("button", { name: "Create Skill" }).click();

    const dialog = page.getByRole("dialog");
    await dialog
      .getByPlaceholder("e.g., Grant Finder, Course Advisor...")
      .fill(skillName);
    await dialog
      .getByPlaceholder("When the user asks about...")
      .fill("When user asks for e2e validation");
    await dialog
      .getByPlaceholder(
        "1. Search for...\n2. Filter by...\n3. Present results with...",
      )
      .fill("Initial instructions");

    await dialog.getByRole("button", { name: "Create Skill" }).click();

    await expect(
      page.getByText(skillName, { exact: true }).first(),
    ).toBeVisible();

    await page.getByText(skillName, { exact: true }).first().click();
    const editDialog = page.getByRole("dialog");
    const instructionsInput = editDialog.getByPlaceholder(
      "1. Search for...\n2. Filter by...\n3. Present results with...",
    );
    await instructionsInput.fill(updatedInstructions);
    await editDialog.getByRole("button", { name: "Save Changes" }).click();

    await page.getByText(skillName, { exact: true }).first().click();
    await expect(
      page
        .getByRole("dialog")
        .getByPlaceholder(
          "1. Search for...\n2. Filter by...\n3. Present results with...",
        ),
    ).toHaveValue(updatedInstructions);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page
      .getByPlaceholder("Search skills...")
      .fill("nonexistent-skill-term");
    await expect(page.getByText("No skills match your search.")).toBeVisible();
    await page.getByPlaceholder("Search skills...").fill("Skill CRUD");
    await expect(
      page.getByText(skillName, { exact: true }).first(),
    ).toBeVisible();

    await acceptNextDialog(page);
    await page.getByLabel(`Delete ${skillName}`).click();

    await expect(page.getByText(skillName, { exact: true })).toHaveCount(0);
  });
});
