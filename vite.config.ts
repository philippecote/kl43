import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    target: "es2022",
    outDir: "dist",
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
});
