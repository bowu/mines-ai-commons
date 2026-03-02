import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";

type Journal = {
  entries: Array<{ idx: number; tag: string }>;
};

describe("drizzle migration assets", () => {
  it("includes a drizzle journal file", async () => {
    const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
    const journalRaw = await fs.readFile(journalPath, "utf8");
    const journal = JSON.parse(journalRaw) as Journal;

    expect(Array.isArray(journal.entries)).toBe(true);
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("journal entries map to SQL migration files", async () => {
    const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
    const journalRaw = await fs.readFile(journalPath, "utf8");
    const journal = JSON.parse(journalRaw) as Journal;

    const files = await fs.readdir(MIGRATIONS_FOLDER);
    const sqlFiles = new Set(files.filter((file) => file.endsWith(".sql")));

    for (const entry of journal.entries) {
      expect(sqlFiles.has(`${entry.tag}.sql`)).toBe(true);
    }
  });
});
