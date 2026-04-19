import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: process.env.GITHUB_PAGES ? "/kl43/" : "/",
  build: {
    target: "es2022",
    outDir: "dist",
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
});
