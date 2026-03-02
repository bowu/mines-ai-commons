import { type Page, expect, test } from "@playwright/test";
import { cleanupE2EAgents, e2eName } from "./helpers";

test.describe("agents page", () => {
  test.describe.configure({ timeout: 180_000 });

  function modelSelect(page: Page) {
    return page.locator('[data-testid="chat-view"] button[role="combobox"]');
  }

  async function waitForChatReady(page: Page) {
    await expect(async () => {
      await page.getByRole("button", { name: "Chat" }).click();

      const fetchError = page.getByText("Failed to fetch");
      if (await fetchError.isVisible().catch(() => false)) {
        await page.reload();
        await page.getByRole("button", { name: "Chat" }).click();
      }

      const wakeButton = page.getByRole("button", { name: "Wake Agent" });
      if (await wakeButton.isVisible().catch(() => false)) {
        await wakeButton.click();
      }

      const chatInput = page
        .locator("[data-testid='chat-view'] textarea")
        .first();
      await expect(chatInput).toBeVisible({ timeout: 5_000 });
      await expect(chatInput).toBeEditable({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
  }

  test.beforeEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("creates agents and keeps model selection per agent", async ({
    page,
  }) => {
    const agentA = e2eName("Agent A");
    const agentB = e2eName("Agent B");

    await page.goto("/agents");

    // Create Agent A (default model: sonnet 4.6)
    // Capture URL before clicking Create so we can wait for it to change
    // (pre-existing agents may cause the URL to already match /agents/:id/c/:sid)
    await page.getByRole("button", { name: "New Agent" }).click();
    await page.getByPlaceholder("Agent name...").fill(agentA);
    const urlBeforeA = page.url();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // Wait for navigation to a NEW session URL (different from whatever was there before)
    await page.waitForURL(
      (url) =>
        url.pathname !== new URL(urlBeforeA).pathname &&
        /\/agents\/[^/]+\/c\/[^/]+/.test(url.pathname),
      { timeout: 15_000 },
    );
    const agentAPath = new URL(page.url()).pathname;

    // Wait for chat to be fully loaded before interacting
    await waitForChatReady(page);
    await expect(modelSelect(page).first()).toContainText("sonnet 4.6");

    // Create Agent B — wait for URL to change to a DIFFERENT agent's session
    await page.getByRole("button", { name: "New Agent" }).click();
    await page.getByPlaceholder("Agent name...").fill(agentB);
    const urlBeforeB = page.url();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname !== new URL(urlBeforeB).pathname &&
        /\/agents\/[^/]+\/c\/[^/]+/.test(url.pathname),
      { timeout: 15_000 },
    );
    const agentBPath = new URL(page.url()).pathname;

    // Wait for chat to be fully loaded, then change model to gemini 3.1 pro
    await waitForChatReady(page);

    // Radix Select can close if a background re-render occurs; retry until stable
    await expect(async () => {
      await modelSelect(page).first().click();
      await expect(
        page.getByRole("option", { name: "gemini 3.1 pro" }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10_000 });
    await page.getByRole("option", { name: "gemini 3.1 pro" }).click();
    await expect(modelSelect(page).first()).toContainText("gemini 3.1 pro");

    // Switch to Agent A via its sidebar conversation link
    await page.locator(`a[href="${agentAPath}"]`).click();
    await expect(page).toHaveURL(agentAPath);
    await waitForChatReady(page);
    await expect(async () => {
      await expect(modelSelect(page).first()).toContainText("sonnet 4.6", {
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });

    // Switch back to Agent B
    await page.locator(`a[href="${agentBPath}"]`).click();
    await expect(page).toHaveURL(agentBPath);
    await waitForChatReady(page);
    await expect(async () => {
      await expect(modelSelect(page).first()).toContainText("gemini 3.1 pro", {
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  test("sidebar navigation between pages", async ({ page }) => {
    // Start from Skills to avoid agents auto-redirect race
    await page.goto("/skills");
    await expect(page).toHaveURL(/\/skills$/);

    // Navigate to Agents via brand header link
    await page.locator('a[href="/agents"]').first().click();
    await expect(page).toHaveURL(/\/agents(\/.*)?$/);

    // Navigate back to Skills via sidebar
    await page
      .getByRole("link", { name: /^Skills$/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/skills$/);
  });
});
