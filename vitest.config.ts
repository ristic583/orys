import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests run real git and child processes; under a full parallel run 5 s was too tight.
    testTimeout: 20_000,
    // Worktrees under .claude/ hold copies of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
