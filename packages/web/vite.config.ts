import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API runs separately (`pnpm nf serve`); proxy it so cookies and SSE are same-origin.
const target = process.env.NATUROFLOW_URL ?? "http://127.0.0.1:7788";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target, changeOrigin: true }, "/auth": { target, changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
