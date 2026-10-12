import type { NextConfig } from "next";
import { assertSafePublicSupabaseKeys } from "./src/lib/database/env";

assertSafePublicSupabaseKeys();

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
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
