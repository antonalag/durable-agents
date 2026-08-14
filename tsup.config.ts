import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/langgraph.ts",
    "src/adapters/ai-sdk.ts",
    "src/dashboard/index.ts",
    "src/cli.ts",
  ],
  format: ["esm", "cjs"],
  dts: false,
  clean: true,
  splitting: true,
});
