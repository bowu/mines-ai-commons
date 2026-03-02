import { afterEach, describe, expect, it } from "vitest";
import { optional, required } from "./config.js";

const TEST_ENV_KEY = "PHASE0_TEST_REQUIRED";

afterEach(() => {
  delete process.env[TEST_ENV_KEY];
});

describe("config helpers", () => {
  it("required throws for missing env var", () => {
    expect(() => required(TEST_ENV_KEY)).toThrow(
      "Missing required environment variable",
    );
  });

  it("required returns value when set", () => {
    process.env[TEST_ENV_KEY] = "abc123";
    expect(required(TEST_ENV_KEY)).toBe("abc123");
  });

  it("optional returns fallback when unset", () => {
    expect(optional("PHASE0_TEST_OPTIONAL", "fallback-value")).toBe(
      "fallback-value",
    );
  });
});
