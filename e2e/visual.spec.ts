import { type Page, expect, test } from "@playwright/test";
import {
  cleanupE2EAgents,
  cleanupE2ESkills,
  createE2EAgent,
  waitForSandboxReady,
} from "./helpers";

const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://127.0.0.1:3001";

/** Inject CSS to disable all animations/transitions for deterministic screenshots */
async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }`,
  });
}

/** Create a test skill via API */
async function createE2ESkill(
  request: import("@playwright/test").APIRequestContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${API_BASE_URL}/api/skills`, {
    multipart: {
      name,
      when_to_use: "When the user asks about test topics",
      instructions: "1. Search for information\n2. Present results",
    },
  });

  if (!response.ok()) {
    throw new Error(`Failed to create e2e skill: ${response.status()}`);
  }

  const payload = (await response.json()) as {
    skill: { id: string; name: string };
  };
  return payload.skill;
}

test.describe("Visual regression", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupE2EAgents(request);
    await cleanupE2ESkills(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
    await cleanupE2ESkills(request);
  });

  test("Agents page — empty state", async ({ page, request }) => {
    // Create an agent so the page renders the chat empty state
    const agent = await createE2EAgent(request, "Visual Test");
    await waitForSandboxReady(request, agent.id);

    await page.goto(`/agents/${agent.id}`);
    await page.waitForSelector('[data-testid="agents-page"]', {
      timeout: 10_000,
    });
    // Wait for session redirect and chat to load
    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 10_000,
    });
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("agents-empty-state.png", {
      maxDiffPixelRatio: 0.01,
      mask: [page.getByText(/Good (morning|afternoon|evening)/)],
    });
  });

  test("Skills page — with skill", async ({ page, request }) => {
    await createE2ESkill(request, "[e2e] Visual Test Skill");

    await page.goto("/skills");
    await page.waitForSelector('[data-testid="skills-page"]', {
      timeout: 10_000,
    });
    // Wait for the skill card to render
    await expect(page.getByText("[e2e] Visual Test Skill").first()).toBeVisible(
      {
        timeout: 5000,
      },
    );
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("skills-page.png", {
      maxDiffPixelRatio: 0.01,
      // Mask date badges which change daily
      mask: [page.locator(".text-\\[10px\\]").last()],
    });
  });

  test("Skills page — empty state", async ({ page }) => {
    await page.goto("/skills");
    await page.waitForSelector('[data-testid="skills-page"]', {
      timeout: 10_000,
    });
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("skills-empty-state.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("Mobile viewport — agents page", async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const agent = await createE2EAgent(request, "Visual Mobile");
    await waitForSandboxReady(request, agent.id);

    await page.goto(`/agents/${agent.id}`);
    await page.waitForSelector('[data-testid="agents-page"]', {
      timeout: 10_000,
    });
    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 10_000,
    });
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("mobile-agents.png", {
      maxDiffPixelRatio: 0.01,
      mask: [page.getByText(/Good (morning|afternoon|evening)/)],
    });
  });
});
