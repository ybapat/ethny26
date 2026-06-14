import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server.
//
// By default the app runs against the in-browser mock engine (src/data/mockEngine.ts).
// To run LIVE against the Canton ledger, start the backend gateway
// (cd backend && npm run gateway → http://localhost:8080) and launch with:
//   VITE_BACKEND_URL=http://localhost:8080 npm run dev
// The LiveBackend (src/data/liveBackend.ts) then calls the gateway directly
// (CORS is enabled there). The `/api` proxy below is a convenience so a
// same-origin "/api/..." path also works if you prefer not to rely on CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
