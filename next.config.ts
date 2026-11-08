import type { NextConfig } from "next";

// AI SDK providers read *_BASE_URL at import time and reject an empty string, so a blank line
// copied from .env.example (e.g. `OPENAI_BASE_URL=`) would break the build. Blank means unset.
for (const key of Object.keys(process.env)) if (key.endsWith("_BASE_URL") && process.env[key]?.trim() === "") delete process.env[key];

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  devIndicators: false,
  // Embedded Postgres ships WASM + data files; load it from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "sharp"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
