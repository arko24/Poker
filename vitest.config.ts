import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" -> "./src/*" path alias so unit tests can
      // import engine modules the same way application code does.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The scaffold ships with no tests yet; later features add the engine
    // suites. Exit 0 rather than failing when no test files are present.
    passWithNoTests: true,
  },
});
