import { describe, expect, it, vi } from "vitest";

describe("gce startup script hardening", () => {
  it("keeps GCE startup env proxy-only by default in non-production", async () => {
    const prev = {
      NODE_ENV: process.env.NODE_ENV,
      SANDBOX_MODE: process.env.SANDBOX_MODE,
      DEV_GCE_ALLOW_PROVIDER_KEYS: process.env.DEV_GCE_ALLOW_PROVIDER_KEYS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_REGION: process.env.AWS_REGION,
    };

    process.env.NODE_ENV = "development";
    process.env.SANDBOX_MODE = "gce";
    process.env.DEV_GCE_ALLOW_PROVIDER_KEYS = undefined;
    process.env.GEMINI_API_KEY = "gemini-dev-key";
    process.env.AWS_ACCESS_KEY_ID = "aws-dev-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-dev-secret";
    process.env.AWS_REGION = "us-west-2";

    vi.resetModules();
    const { _testOnly } = await import("./gce.js");

    const script = _testOnly.buildStartupScript(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(script).not.toContain("GEMINI_API_KEY=");
    expect(script).not.toContain("AWS_ACCESS_KEY_ID=");
    expect(script).not.toContain("AWS_SECRET_ACCESS_KEY=");
    expect(script).not.toContain("AWS_REGION=");

    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it("does not embed provider keys into startup metadata in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const { _testOnly } = await import("./gce.js");

    const script = _testOnly.buildStartupScript(
      "11111111-1111-1111-1111-111111111111",
    );

    expect(script).not.toContain("GEMINI_API_KEY=");
    expect(script).not.toContain("BRAVE_API_KEY=");
    expect(script).not.toContain("AWS_ACCESS_KEY_ID=");
    expect(script).not.toContain("AWS_SECRET_ACCESS_KEY=");
    expect(script).not.toContain("AWS_SESSION_TOKEN=");
    expect(script).not.toContain("BEDROCK_ROLE_ARN=");

    if (previousNodeEnv === undefined) {
      process.env.NODE_ENV = undefined;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    vi.resetModules();
  });

  it("uses stop fallback for GPU instances that cannot suspend", async () => {
    vi.resetModules();
    const { _testOnly } = await import("./gce.js");

    expect(
      _testOnly.shouldStopInsteadOfSuspend({
        machineType: "zones/us-central1-f/machineTypes/a2-highgpu-1g",
      }),
    ).toBe(true);
    expect(
      _testOnly.shouldStopInsteadOfSuspend({
        machineType: "zones/us-central1-f/machineTypes/e2-medium",
      }),
    ).toBe(false);
    expect(
      _testOnly.shouldStopInsteadOfSuspend({
        machineType: "zones/us-central1-f/machineTypes/custom",
        guestAccelerators: [{ acceleratorCount: 1 }],
      }),
    ).toBe(true);
  });
});
