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
  esbuildOptions(options, context) {
    if (context.format === "cjs") {
      options.define = {
        ...options.define,
        "import.meta.url": "importMetaUrlShim",
      };
      options.inject = [...(options.inject ?? []), "./tsup.import-meta-url.js"];
    }
  },
});
