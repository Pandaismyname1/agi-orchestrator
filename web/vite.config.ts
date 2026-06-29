import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

/**
 * The dashboard backend (npm run dashboard) runs on :4317 and owns the WebSocket
 * (/ws) + read APIs (/api/*). In dev we run Vite on :5173 and proxy those through,
 * so the SPA talks to the real backend. The production build is emitted to web/dist
 * and served directly by the Node server.
 */
const BACKEND = "http://localhost:4317";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: BACKEND, ws: true },
      "/api": BACKEND,
      "/attach": BACKEND,
      "/detach": BACKEND,
      "/hook": BACKEND,
    },
  },
});
