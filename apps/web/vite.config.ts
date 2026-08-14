import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Declared narrowly rather than pulling @types/node into the browser app, which
// would let Node APIs typecheck inside client code by accident.
declare const process: { env: Record<string, string | undefined> };

// Honour an assigned PORT so the dev server can be started on a free port
// instead of fighting for a hardcoded one.
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: { port },
  preview: { port },
});
