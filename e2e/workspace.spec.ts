import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  acceptNextDialog,
  cleanupE2EAgents,
  createE2EAgent,
  waitForSandboxReady,
} from "./helpers";

test.describe("workspace", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("creates folder, uploads file, previews, and deletes file", async ({
    page,
    request,
  }) => {
    const agent = await createE2EAgent(request, "Workspace");
    await waitForSandboxReady(request, agent.id);
    const folderName = "reports";
    const fileName = "notes.txt";
    const fileContent = "Playwright workspace upload content";

    const tempDir = test.info().outputPath("uploads");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, fileName);
    await fs.writeFile(tempFilePath, fileContent, "utf8");

    await page.goto(`/agents/${agent.id}`);
    // Wait for session redirect to settle before switching tabs
    await expect(page).toHaveURL(/\/agents\/[^/]+\/c\/[^/]+/);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();

    await acceptNextDialog(page, folderName);
    await page.getByRole("button", { name: "New Folder" }).click();
    await expect(page.getByText(folderName, { exact: true })).toBeVisible();

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(tempFilePath);

    await expect(page.getByText(fileName, { exact: true })).toBeVisible();

    await page.getByText(fileName, { exact: true }).click();
    await expect(page.getByText(fileContent)).toBeVisible();

    await acceptNextDialog(page);
    await page
      .getByRole("button", { name: /^Delete/ })
      .first()
      .click();

    await expect(
      page.getByRole("button", { name: new RegExp(`^Delete ${fileName}$`) }),
    ).toHaveCount(0);
  });
});
