import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/langgraph.ts",
    "src/adapters/ai-sdk.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: true,
});
