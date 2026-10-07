import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // changeOrigin would rewrite Host to :3000 while the browser's Origin stays :5173,
  // and the API then rejects the save as cross-site.
  server: {
    // The client imports the shared note limits from server/src, one directory up.
    fs: { allow: [".."] },
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
});
