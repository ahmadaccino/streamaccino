#!/usr/bin/env bun
/**
 * streamaccino — Hero video encoder & R2 uploader
 *
 * Encodes a source video into a bitrate ladder optimised for short (≤30s)
 * hero/background videos on the web, then uploads every rendition to
 * Cloudflare R2 via wrangler (uses your `wrangler login` session — no .env needed).
 *
 * Usage:
 *   bun run upload.ts <video-file>
 *
 * Requirements:
 *   - ffmpeg / ffprobe on PATH
 *   - wrangler on PATH, authenticated (`wrangler login`)
 */

import { select, input, confirm } from "@inquirer/prompts";
import { basename, extname, join, resolve } from "path";
import { existsSync, mkdirSync, statSync, rmSync } from "fs";

// ─── Encoding profiles ──────────────────────────────────────────────────────
// CRF + VBV-capped for short hero videos.  Audio is stripped.

interface Profile {
  tag: string;
  width: number;
  height: number;
  h264Crf: number;
  h264Maxrate: string;
  h264Bufsize: string;
  h265Crf: number;
  h265Maxrate: string;
  h265Bufsize: string;
}

const PROFILES: Profile[] = [
  {
    tag: "2160p",
    width: 3840,
    height: 2160,
    h264Crf: 23,
    h264Maxrate: "12M",
    h264Bufsize: "24M",
    h265Crf: 26,
    h265Maxrate: "8M",
    h265Bufsize: "16M",
  },
  {
    tag: "1080p",
    width: 1920,
    height: 1080,
    h264Crf: 22,
    h264Maxrate: "5M",
    h264Bufsize: "10M",
    h265Crf: 25,
    h265Maxrate: "3M",
    h265Bufsize: "6M",
  },
  {
    tag: "720p",
    width: 1280,
    height: 720,
    h264Crf: 23,
    h264Maxrate: "3M",
    h264Bufsize: "6M",
    h265Crf: 26,
    h265Maxrate: "1.8M",
    h265Bufsize: "3.6M",
  },
  {
    tag: "480p",
    width: 854,
    height: 480,
    h264Crf: 24,
    h264Maxrate: "1.5M",
    h264Bufsize: "3M",
    h265Crf: 27,
    h265Maxrate: "900k",
    h265Bufsize: "1.8M",
  },
];

// ─── Shell helpers ───────────────────────────────────────────────────────────

/** Run a command and return trimmed stdout. Throws on non-zero exit. */
async function run(cmd: string[], opts?: { env?: Record<string, string> }): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts?.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}\n${stderr}`);
  }
  return stdout.trim();
}

// ─── Wrangler helpers ────────────────────────────────────────────────────────

interface Account {
  name: string;
  id: string;
}

async function getAccounts(): Promise<Account[]> {
  const out = await run(["wrangler", "whoami"]);
  const accounts: Account[] = [];
  // Parse the ASCII table: │ Name │ ID │
  for (const line of out.split("\n")) {
    const match = line.match(/^│\s+(.+?)\s+│\s+([a-f0-9]{32})\s+│$/);
    if (match) {
      accounts.push({ name: match[1].trim(), id: match[2] });
    }
  }
  return accounts;
}

async function listBuckets(accountId: string): Promise<string[]> {
  const out = await run(["wrangler", "r2", "bucket", "list"], {
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  // Output is JSON array or table — wrangler r2 bucket list outputs JSON-ish
  // Try JSON first, fall back to line parsing
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      return parsed.map((b: any) => b.name).filter(Boolean);
    }
  } catch {
    // Fall back: parse lines like "  - name: my-bucket"
  }
  const buckets: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/name:\s*(.+)/);
    if (m) buckets.push(m[1].trim());
  }
  return buckets;
}

/**
 * List "folders" at a given prefix using the Cloudflare API directly via wrangler's
 * stored OAuth token. Since wrangler r2 object doesn't have a list command,
 * we shell out to the CF API.
 *
 * Fallback: just let users type a path.
 */
async function listFolders(accountId: string, bucket: string, prefix: string): Promise<string[]> {
  // Use wrangler's auth token from the config
  try {
    // wrangler doesn't expose list-objects, so we use the REST API with the stored token.
    // Read the OAuth token wrangler stored.
    const configDir =
      process.env.XDG_CONFIG_HOME ??
      join(process.env.HOME ?? "~", "Library", "Preferences");
    const tokenPath = join(configDir, ".wrangler", "config", "default.toml");

    let token = "";
    if (existsSync(tokenPath)) {
      const content = await Bun.file(tokenPath).text();
      const m = content.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (m) token = m[1];
    }

    if (!token) return [];

    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`,
    );
    url.searchParams.set("delimiter", "/");
    if (prefix) url.searchParams.set("prefix", prefix);

    // The V4 list-objects endpoint
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const prefixes: string[] = (data.result?.delimited_prefixes ?? []) as string[];
    return prefixes;
  } catch {
    return [];
  }
}

async function uploadToR2(
  accountId: string,
  bucket: string,
  key: string,
  filePath: string,
) {
  const size = statSync(filePath).size;
  console.log(`  ☁️   Uploading ${key} (${(size / 1024 / 1024).toFixed(2)} MB)…`);
  const t0 = performance.now();

  const proc = Bun.spawn(
    [
      "wrangler", "r2", "object", "put",
      `${bucket}/${key}`,
      "--file", filePath,
      "--content-type", "video/mp4",
      "--cache-control", "public, max-age=31536000, immutable",
      "--remote",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Upload failed for ${key}:\n${stderr}`);
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅  Uploaded ${key} in ${elapsed}s`);
}

// ─── ffmpeg helpers ──────────────────────────────────────────────────────────

async function probeVideo(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await run([
    "ffprobe",
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    file,
  ]);
  const info = JSON.parse(out);
  const vs = info.streams?.find((s: any) => s.codec_type === "video");
  if (!vs) throw new Error("No video stream found");
  return {
    width: Number(vs.width),
    height: Number(vs.height),
    duration: Number(info.format?.duration ?? vs.duration ?? 0),
  };
}

async function encode(
  src: string,
  outDir: string,
  profile: Profile,
  codec: "h264" | "h265",
  stem: string,
): Promise<string> {
  const outFile = join(outDir, `${stem}_${profile.tag}_${codec}.mp4`);

  const crf = codec === "h264" ? profile.h264Crf : profile.h265Crf;
  const maxrate = codec === "h264" ? profile.h264Maxrate : profile.h265Maxrate;
  const bufsize = codec === "h264" ? profile.h264Bufsize : profile.h265Bufsize;

  const codecArgs =
    codec === "h264"
      ? ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level", "4.1"]
      : ["-c:v", "libx265", "-preset", "slow", "-tag:v", "hvc1"];

  const scaleFilter = [
    `scale=min(${profile.width}\\,iw):min(${profile.height}\\,ih)`,
    ":force_original_aspect_ratio=decrease",
    ",scale=trunc(iw/2)*2:trunc(ih/2)*2",
  ].join("");

  const args = [
    "ffmpeg", "-y",
    "-i", src,
    ...codecArgs,
    "-crf", String(crf),
    "-maxrate", maxrate,
    "-bufsize", bufsize,
    "-vf", scaleFilter,
    "-an",
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    outFile,
  ];

  console.log(`  ⏳  Encoding ${profile.tag} ${codec}…`);
  const t0 = performance.now();

  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error(stderr);
    throw new Error(`ffmpeg exited ${code} for ${profile.tag} ${codec}`);
  }

  const size = statSync(outFile).size;
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅  ${profile.tag} ${codec}  →  ${(size / 1024 / 1024).toFixed(2)} MB  (${elapsed}s)`);
  return outFile;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Validate input
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: bun run upload.ts <video-file>");
    process.exit(1);
  }
  const absInput = resolve(inputFile);
  if (!existsSync(absInput)) {
    console.error(`❌  File not found: ${absInput}`);
    process.exit(1);
  }

  const stem = basename(absInput, extname(absInput));
  console.log(`\n🎬  Source: ${absInput}`);

  const probe = await probeVideo(absInput);
  console.log(`   ${probe.width}×${probe.height}  •  ${probe.duration.toFixed(1)}s\n`);

  // 2. Select account
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    console.error("❌  No accounts found. Run `wrangler login` first.");
    process.exit(1);
  }

  const accountId =
    accounts.length === 1
      ? accounts[0].id
      : await select({
          message: "Cloudflare account:",
          choices: accounts.map((a) => ({
            name: `${a.name}  (${a.id.slice(0, 8)}…)`,
            value: a.id,
          })),
        });

  console.log(`   Using account ${accountId.slice(0, 8)}…\n`);

  // 3. Select bucket
  const buckets = await listBuckets(accountId);
  if (buckets.length === 0) {
    console.error("❌  No R2 buckets found in this account.");
    process.exit(1);
  }

  const bucket = await select({
    message: "R2 bucket:",
    choices: buckets.map((b) => ({ name: b, value: b })),
  });

  // 4. Browse / create folder
  let prefix = "";
  while (true) {
    const folders = await listFolders(accountId, bucket, prefix);

    const choices: { name: string; value: string }[] = [
      { name: `📁  Use current path: /${prefix || ""}`, value: "__use__" },
      { name: "✏️   Type a new folder name", value: "__new__" },
    ];

    if (folders.length > 0) {
      for (const f of folders) {
        // Show just the last segment
        const display = f.replace(prefix, "");
        choices.push({ name: `📂  ${display}`, value: f });
      }
    }

    const pick = await select({ message: "Destination folder:", choices });

    if (pick === "__use__") break;
    if (pick === "__new__") {
      const name = await input({ message: `New folder under "/${prefix}":` });
      prefix = prefix + name.replace(/^\/+|\/+$/g, "") + "/";
      break;
    }
    prefix = pick;
  }

  // 5. Choose codecs
  const codecs = await select({
    message: "Codecs to encode:",
    choices: [
      { name: "H.264 only  (best compat)", value: "h264" },
      { name: "H.265 only  (smaller, Safari+Chrome)", value: "h265" },
      { name: "Both H.264 + H.265  (recommended)", value: "both" },
    ],
  }) as string;

  const selectedCodecs: ("h264" | "h265")[] =
    codecs === "both" ? ["h264", "h265"] : [codecs as "h264" | "h265"];

  // 6. Filter profiles (don't upscale)
  const applicableProfiles = PROFILES.filter(
    (p) => p.width <= probe.width || p.height <= probe.height,
  );
  if (applicableProfiles.length === 0) {
    console.error("❌  Source resolution too small for any profile");
    process.exit(1);
  }

  console.log(`\n📐  Profiles: ${applicableProfiles.map((p) => p.tag).join(", ")}`);
  console.log(`🎞️   Codecs:   ${selectedCodecs.join(", ")}`);
  console.log(`📦  Dest:     r2://${bucket}/${prefix}${stem}/\n`);

  const ok = await confirm({ message: "Start encoding & upload?" });
  if (!ok) process.exit(0);

  // 7. Encode
  const tmpDir = join(import.meta.dir, ".streamaccino-tmp", stem);
  mkdirSync(tmpDir, { recursive: true });

  console.log(`\n🔧  Encoding to ${tmpDir}\n`);

  const outputs: { file: string; key: string }[] = [];

  for (const profile of applicableProfiles) {
    for (const codec of selectedCodecs) {
      const outFile = await encode(absInput, tmpDir, profile, codec, stem);
      const key = `${prefix}${stem}/${basename(outFile)}`;
      outputs.push({ file: outFile, key });
    }
  }

  // 8. Upload
  console.log(`\n☁️   Uploading ${outputs.length} files to r2://${bucket}/${prefix}${stem}/\n`);

  for (const { file, key } of outputs) {
    await uploadToR2(accountId, bucket, key, file);
  }

  // 9. Summary
  console.log("\n🎉  Done! Uploaded files:\n");
  for (const { key } of outputs) {
    console.log(`    → ${key}`);
  }

  // Cleanup
  console.log("");
  const cleanup = await confirm({ message: "Delete local encoded files?", default: true });
  if (cleanup) {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log("🗑️   Cleaned up temp files.");
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
