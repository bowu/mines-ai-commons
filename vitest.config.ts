import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/mines_ai_test",
    },
  },
});
