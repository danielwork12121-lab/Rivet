import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The Apify Actor has its own package and tests: cd apify/robot-spec-finder && npm test
    exclude: [...configDefaults.exclude, "apify/**"],
  },
});
