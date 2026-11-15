import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 43123, strictPort: true, proxy: { "/api": "http://127.0.0.1:43124" } },
  build: { outDir: "dist", emptyOutDir: true },
});
