import type { APIRequestContext, Page } from "@playwright/test";

const API_BASE_URL = process.env.E2E_API_BASE_URL || "http://127.0.0.1:3001";
export const E2E_PREFIX = "[e2e]";

export function e2eName(label: string): string {
  return `${E2E_PREFIX} ${label}`;
}

export async function cleanupE2EAgents(request: APIRequestContext) {
  // Use the test-only bulk cleanup endpoint (bypasses per-agent ACL)
  const res = await request.delete(`${API_BASE_URL}/api/test/agents`);
  if (!res.ok()) {
    console.warn(`E2E cleanup: agents bulk delete returned ${res.status()}`);
  }
}

export async function cleanupE2ESkills(request: APIRequestContext) {
  // Use the test-only bulk cleanup endpoint (bypasses per-skill ACL)
  const res = await request.delete(`${API_BASE_URL}/api/test/skills`);
  if (!res.ok()) {
    console.warn(`E2E cleanup: skills bulk delete returned ${res.status()}`);
  }
}

export async function createE2EAgent(
  request: APIRequestContext,
  label: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${API_BASE_URL}/api/agents`, {
    data: { name: e2eName(label) },
  });

  if (!response.ok()) {
    throw new Error(`Failed to create e2e agent: ${response.status()}`);
  }

  const payload = (await response.json()) as {
    agent: { id: string; name: string };
  };
  return payload.agent;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSandboxReady(
  request: APIRequestContext,
  agentId: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    let response: Awaited<ReturnType<APIRequestContext["post"]>> | null = null;
    try {
      response = await request.post(
        `${API_BASE_URL}/api/sandbox/${agentId}/ensure`,
      );
    } catch {
      await waitMs(500);
      continue;
    }

    if (response.ok()) {
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
      } | null;
      if (!payload || payload.status === "ready") {
        return;
      }
    } else if ([500, 502, 503, 504].includes(response.status())) {
      const payload = (await response.json().catch(() => null)) as {
        retryAfterMs?: number;
      } | null;
      const retryAfterMs = Math.min(payload?.retryAfterMs ?? 500, 2_000);
      await waitMs(retryAfterMs);
      continue;
    } else {
      throw new Error(
        `Sandbox ensure failed for ${agentId}: ${response.status()}`,
      );
    }

    await waitMs(400);
  }

  throw new Error(`Sandbox did not become ready for agent ${agentId}`);
}

export async function acceptNextDialog(page: Page, answer?: string) {
  page.once("dialog", async (dialog) => {
    if (answer !== undefined) {
      await dialog.accept(answer);
      return;
    }
    await dialog.accept();
  });
}
