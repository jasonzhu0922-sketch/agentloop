import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is served separately (default http://127.0.0.1:8787). During `npm
// run dev`, requests to /v1/* are proxied to the API so the SPA can use
// same-origin paths; in production, serve the built assets behind the API's
// CORS allowlist or a reverse proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.AGENTLOOP_API_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
