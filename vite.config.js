import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and looks for the build output in `dist`.
// For GitHub Pages project sites the app is served from /<repo-name>/.
// The Actions workflow sets BASE_PATH; locally it defaults to "/".
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
});
