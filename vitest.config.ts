import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Runs once per test file, before its tests. It arms the two guarantees no suite
    // may opt out of — no real network, no non-GET request — so they hold for a file
    // written next month by someone who never read this config. See test/README.md.
    setupFiles: ["test/support/setup.ts"],
  },
});
