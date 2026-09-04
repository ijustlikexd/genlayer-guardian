import { defineConfig } from "vite";

// base: './' so the built assets resolve with relative paths, which is what
// GitHub Pages needs when the site is served from a project subpath
// (https://<user>.github.io/<repo>/) rather than the domain root.
export default defineConfig({
  root: __dirname,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
