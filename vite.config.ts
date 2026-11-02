import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "client",
  resolve: { alias: { "@": path.resolve("client/src") } },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png", "favicon.svg"],
      manifest: {
        name: "Hub of Me",
        short_name: "Hub of Me",
        description: "A personal reasoning system. Judgment, not instructions.",
        theme_color: "#0c0b09",
        background_color: "#0c0b09",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
      injectRegister: false,
      workbox: {
        // A new version takes over at once and old copies are thrown away, so a deploy is never hidden behind a cached page.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:43124" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
