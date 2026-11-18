import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://localhost:${process.env.AIPM_PORT ?? 4317}`;
// The static demo (pnpm build:demo) ships the recording from scripts/demo-snapshot.ts instead of the plain public folder.
const demo = process.env.VITE_ORYS_DEMO === "1";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  publicDir: demo ? "demo-public" : "public",
  build: { outDir: "dist", emptyOutDir: true },
  // The demo answers /api from its recording (and its images are static files), so it must not proxy to an engine.
  server: { port: 5173, proxy: demo ? {} : { "/api": { target: api, changeOrigin: true } } },
  preview: { proxy: {} },
});
