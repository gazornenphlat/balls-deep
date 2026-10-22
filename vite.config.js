import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Capacitor serves the built app from a file:// / custom scheme on Android,
  // so asset paths must be relative rather than absolute.
  base: "./",
});
