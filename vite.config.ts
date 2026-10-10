import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The published site lives under a sub-path (…github.io/portal-ball/);
  // the deploy workflow sets BASE_PATH. Local dev serves from the root.
  base: process.env.BASE_PATH || "/",
  server: {
    // getUserMedia needs a secure context. localhost counts as secure,
    // so plain http is fine here; use --host only with https.
    port: 5173,
    open: "/game.html",
  },
  build: {
    target: "es2022",
    rollupOptions: {
      // Two pages: game.html is the actual game, index.html is the Spike 0
      // measurement harness kept around for diagnosing tracking/latency issues.
      input: {
        game: dir("./game.html"),
        diagnostics: dir("./index.html"),
      },
    },
  },
});
