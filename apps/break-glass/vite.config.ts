import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local demo only: bind to 127.0.0.1 and proxy /api to the local service.
const service = process.env.COVEN_SERVICE ?? "http://127.0.0.1:8787";

// Strict content security policy for the built app (vite preview).
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": service } },
  preview: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: { "/api": service },
    headers: { "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  },
  build: { sourcemap: false },
});
