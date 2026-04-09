#!/usr/bin/env bun
/**
 * Build script for streamaccino.
 * Creates single-file executables for macOS (arm64 + x64).
 */

import { mkdirSync } from "fs";

const VERSION = "0.1.0";

mkdirSync("dist", { recursive: true });

const targets = [
  { target: "bun-darwin-arm64" as const, outfile: "dist/streamaccino-darwin-arm64" },
  { target: "bun-darwin-x64" as const, outfile: "dist/streamaccino-darwin-x64" },
  { target: "bun-linux-x64" as const, outfile: "dist/streamaccino-linux-x64" },
  { target: "bun-linux-arm64" as const, outfile: "dist/streamaccino-linux-arm64" },
];

for (const { target, outfile } of targets) {
  console.log(`Building ${target}...`);
  const result = await Bun.build({
    entrypoints: ["./upload.ts"],
    compile: {
      target,
      outfile,
    },
    minify: true,
    define: {
      BUILD_VERSION: JSON.stringify(VERSION),
    },
  });

  if (!result.success) {
    console.error(`Failed to build ${target}:`, result.logs);
    process.exit(1);
  }
  console.log(`  ✅ ${outfile}`);
}

console.log("\nDone! Binaries in dist/");
