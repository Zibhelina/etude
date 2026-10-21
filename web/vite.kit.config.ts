// Builds the editor kit that card frames import: highlighting for any language, the code editor
// and the live markdown editor. Languages load as separate chunks only when a card needs them.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: process.env.ETUDE_KIT_OUT ?? "dist/kit",
    emptyOutDir: true,
    copyPublicDir: false,
    chunkSizeWarningLimit: 1500,
    lib: { entry: fileURLToPath(new URL("./src/editor/kit.ts", import.meta.url)), formats: ["es"], fileName: () => "kit.js" },
  },
});
