import path from "node:path";
import { describe, expect, it } from "vitest";
import { jailPath, sanitizeRelativePath } from "./path-utils.js";

describe("path utils", () => {
  it("allows workspace root and descendants", () => {
    const root = "/workspace";

    expect(jailPath(root, ".")).toBe("/workspace");
    expect(jailPath(root, "reports/output.txt")).toBe(
      path.resolve("/workspace", "reports/output.txt"),
    );
  });

  it("rejects traversal and prefix collisions", () => {
    const root = "/workspace";

    expect(() => jailPath(root, "../etc/passwd")).toThrow(
      "Path outside workspace",
    );
    expect(() => jailPath(root, "../workspace-evil/note.txt")).toThrow(
      "Path outside workspace",
    );
  });

  it("normalizes safe relative paths and rejects unsafe ones", () => {
    expect(sanitizeRelativePath("a/../b/file.txt")).toBe("b/file.txt");
    expect(() => sanitizeRelativePath("../outside")).toThrow("Invalid path");
    expect(() => sanitizeRelativePath("/absolute/path")).toThrow(
      "Invalid path",
    );
  });
});
