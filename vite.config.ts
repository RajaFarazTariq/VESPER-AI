import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app lives in src/web and is built into ./dist, which the Worker serves as static assets.
export default defineConfig({
  root: "src/web",
  publicDir: "../../public",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  // The spreadsheet reader runs in a module worker (v0.14.0).
  worker: { format: "es" },
  server: {
    port: 5173,
    // During development the API runs in `wrangler dev` on port 8787.
    // The web app's own source in src/web/api/ is also served under /api/ (e.g. /api/client.ts),
    // so .ts/.tsx module requests stay with Vite; everything else under /api/ goes to the Worker.
    proxy: {
      "^/api/(?!.*\\.tsx?(?:\\?|$))": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
});
