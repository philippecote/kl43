import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  base: process.env.GITHUB_PAGES ? "/kl43/" : "/",
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pair: resolve(__dirname, "pair.html"),
      },
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
});
