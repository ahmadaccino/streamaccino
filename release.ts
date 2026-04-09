#!/usr/bin/env bun
/**
 * Release script for streamaccino.
 *
 * 1. Builds all platform binaries
 * 2. Creates .tar.gz archives for each
 * 3. Computes SHA256 hashes
 * 4. Generates the Homebrew formula with correct hashes
 *
 * After running, create a GitHub release and upload the .tar.gz files from dist/
 * Then push the updated Formula/streamaccino.rb to your homebrew-tap repo.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { $ } from "bun";

const VERSION = "0.1.0";
// Change this to your GitHub username
const GITHUB_USER = "ahmadaccino";
const REPO = "streamaccino";

console.log(`\n📦 Building streamaccino v${VERSION}\n`);

// Step 1: Build all binaries
mkdirSync("dist", { recursive: true });

const targets = [
  { target: "bun-darwin-arm64" as const, name: "streamaccino-darwin-arm64" },
  { target: "bun-darwin-x64" as const, name: "streamaccino-darwin-x64" },
  { target: "bun-linux-x64" as const, name: "streamaccino-linux-x64" },
  { target: "bun-linux-arm64" as const, name: "streamaccino-linux-arm64" },
];

for (const { target, name } of targets) {
  console.log(`  🔨 Building ${target}...`);
  const result = await Bun.build({
    entrypoints: ["./upload.ts"],
    compile: { target, outfile: `dist/${name}` },
    minify: true,
  });
  if (!result.success) {
    console.error(`  ❌ Failed:`, result.logs);
    process.exit(1);
  }
}

// Step 2: Create tar.gz archives
console.log(`\n📦 Creating archives...\n`);

const hashes: Record<string, string> = {};

for (const { name } of targets) {
  // Each archive contains just the binary renamed to "streamaccino"
  await $`cd dist && cp ${name} streamaccino && tar czf ${name}.tar.gz streamaccino && rm streamaccino`;
  const sha = (await $`shasum -a 256 dist/${name}.tar.gz`.text()).split(" ")[0];
  hashes[name] = sha;
  const size = (await Bun.file(`dist/${name}.tar.gz`).arrayBuffer()).byteLength;
  console.log(`  ✅ ${name}.tar.gz  (${(size / 1024 / 1024).toFixed(1)} MB)  sha256:${sha.slice(0, 12)}…`);
}

// Step 3: Generate Homebrew formula
console.log(`\n🍺 Generating Homebrew formula...\n`);

const formula = `# typed: false
# frozen_string_literal: true

class Streamaccino < Formula
  desc "Hero video encoder & Cloudflare R2 uploader"
  homepage "https://github.com/${GITHUB_USER}/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${GITHUB_USER}/${REPO}/releases/download/v${VERSION}/streamaccino-darwin-arm64.tar.gz"
      sha256 "${hashes["streamaccino-darwin-arm64"]}"
    else
      url "https://github.com/${GITHUB_USER}/${REPO}/releases/download/v${VERSION}/streamaccino-darwin-x64.tar.gz"
      sha256 "${hashes["streamaccino-darwin-x64"]}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/${GITHUB_USER}/${REPO}/releases/download/v${VERSION}/streamaccino-linux-arm64.tar.gz"
      sha256 "${hashes["streamaccino-linux-arm64"]}"
    else
      url "https://github.com/${GITHUB_USER}/${REPO}/releases/download/v${VERSION}/streamaccino-linux-x64.tar.gz"
      sha256 "${hashes["streamaccino-linux-x64"]}"
    end
  end

  depends_on "ffmpeg"

  def install
    bin.install "streamaccino"
  end

  test do
    assert_match "streamaccino v#{version}", shell_output("#{bin}/streamaccino --version")
  end
end
`;

writeFileSync("Formula/streamaccino.rb", formula);
console.log(`  ✅ Formula/streamaccino.rb\n`);

// Summary
console.log(`📋 Next steps:\n`);
console.log(`  1. Push this repo to GitHub (https://github.com/${GITHUB_USER}/${REPO})`);
console.log(`  2. Create a release tagged v${VERSION}`);
console.log(`  3. Upload these files to the release:`);
for (const { name } of targets) {
  console.log(`       dist/${name}.tar.gz`);
}
console.log(`  4. Create a repo: https://github.com/${GITHUB_USER}/homebrew-tap`);
console.log(`  5. Copy Formula/streamaccino.rb into that repo at Formula/streamaccino.rb`);
console.log(`  6. Users install with: brew install ${GITHUB_USER}/tap/streamaccino\n`);
