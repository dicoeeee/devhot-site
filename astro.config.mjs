import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  build: {
    format: "directory",
  },
  vite: {
    build: {
      target: ["chrome111", "edge111", "firefox114", "safari16.4"],
    },
  },
});
