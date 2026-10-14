import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  css: { postcss: { plugins: [] } },
  test: { include: ["src/**/*.test.ts"] },
});
