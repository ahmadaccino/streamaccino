#!/usr/bin/env bun
/**
 * streamaccino — Hero video encoder & R2 uploader
 *
 * Encodes a source video into an HLS bitrate ladder (fMP4 segments) optimised
 * for short (≤30s) hero/background videos on the web, then uploads to
 * Cloudflare R2 via wrangler. Outputs a master.m3u8 ready for hls.js.
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
import { existsSync, mkdirSync, statSync, rmSync, readdirSync } from "fs";

// ─── Encoding profiles ──────────────────────────────────────────────────────

interface Profile {
  tag: string;
  width: number;
  height: number;
  h264Crf: number;
  h264Maxrate: string;
  h264Bufsize: string;
  h264Level: string;
  h264Codec: string; // HLS CODECS attribute
  h265Crf: number;
  h265Maxrate: string;
  h265Bufsize: string;
  h265Codec: string;
}

const PROFILES: Profile[] = [
  {
    tag: "2160p",
    width: 3840,
    height: 2160,
    h264Crf: 23, h264Maxrate: "12M",  h264Bufsize: "24M", h264Level: "5.1", h264Codec: "avc1.640033",
    h265Crf: 26, h265Maxrate: "8M",   h265Bufsize: "16M", h265Codec: "hvc1.2.4.L150.90",
  },
  {
    tag: "1080p",
    width: 1920,
    height: 1080,
    h264Crf: 22, h264Maxrate: "5M",   h264Bufsize: "10M", h264Level: "4.1", h264Codec: "avc1.640029",
    h265Crf: 25, h265Maxrate: "3M",   h265Bufsize: "6M",  h265Codec: "hvc1.2.4.L120.90",
  },
  {
    tag: "720p",
    width: 1280,
    height: 720,
    h264Crf: 23, h264Maxrate: "3M",   h264Bufsize: "6M",  h264Level: "3.1", h264Codec: "avc1.64001F",
    h265Crf: 26, h265Maxrate: "1.8M", h265Bufsize: "3.6M",h265Codec: "hvc1.2.4.L93.90",
  },
  {
    tag: "480p",
    width: 854,
    height: 480,
    h264Crf: 24, h264Maxrate: "1.5M", h264Bufsize: "3M",  h264Level: "3.1", h264Codec: "avc1.64001F",
    h265Crf: 27, h265Maxrate: "900k", h265Bufsize: "1.8M", h265Codec: "hvc1.2.4.L90.90",
  },
];

const HLS_SEGMENT_DURATION = 4; // seconds

// ─── Shell helpers ───────────────────────────────────────────────────────────

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

interface Account { name: string; id: string }

function getWranglerToken(): string {
  const configDir =
    process.env.XDG_CONFIG_HOME ??
    join(process.env.HOME ?? "~", "Library", "Preferences");
  const tokenPath = join(configDir, ".wrangler", "config", "default.toml");
  if (!existsSync(tokenPath)) return "";
  const content = require("fs").readFileSync(tokenPath, "utf-8");
  const m = content.match(/oauth_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : "";
}

async function getAccounts(): Promise<{ email: string; accounts: Account[] }> {
  const token = getWranglerToken();
  if (token) {
    try {
      const [userRes, accountsRes] = await Promise.all([
        fetch("https://api.cloudflare.com/client/v4/user", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      let email = "";
      if (userRes.ok) {
        const userData = (await userRes.json()) as any;
        email = userData.result?.email ?? "";
      }
      if (accountsRes.ok) {
        const data = (await accountsRes.json()) as any;
        const accounts: Account[] = (data.result ?? []).map((a: any) => ({
          name: a.name ?? a.id, id: a.id,
        }));
        if (accounts.length > 0) return { email, accounts };
      }
    } catch { /* fall through */ }
  }

  const out = await run(["wrangler", "whoami"]);
  const accounts: Account[] = [];
  const emailMatch = out.match(/associated with the email\s+(\S+)/);
  const email = emailMatch ? emailMatch[1].replace(/[.)]+$/, "") : "";
  for (const line of out.split("\n")) {
    const match = line.match(/^│\s+(.+?)\s+│\s+([a-f0-9]{32})\s+│$/);
    if (match) accounts.push({ name: match[1].trim(), id: match[2] });
  }
  return { email, accounts };
}

async function listBuckets(accountId: string): Promise<string[]> {
  const out = await run(["wrangler", "r2", "bucket", "list"], {
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed.map((b: any) => b.name).filter(Boolean);
  } catch {}
  const buckets: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/name:\s*(.+)/);
    if (m) buckets.push(m[1].trim());
  }
  return buckets;
}

async function listFolders(accountId: string, bucket: string, prefix: string): Promise<string[]> {
  try {
    const token = getWranglerToken();
    if (!token) return [];
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`,
    );
    url.searchParams.set("delimiter", "/");
    if (prefix) url.searchParams.set("prefix", prefix);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.result?.delimited_prefixes ?? []) as string[];
  } catch { return []; }
}

interface BucketDomain {
  url: string;       // e.g. "https://cdn.example.com"
  label: string;     // e.g. "cdn.example.com (custom)" or "pub-xxx.r2.dev (r2.dev)"
}

async function getBucketDomains(accountId: string, bucket: string): Promise<BucketDomain[]> {
  const token = getWranglerToken();
  if (!token) return [];

  const domains: BucketDomain[] = [];
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/domains`;

  try {
    // Custom domains
    const customRes = await fetch(`${base}/custom`, { headers });
    if (customRes.ok) {
      const data = (await customRes.json()) as any;
      for (const d of data.result?.domains ?? []) {
        if (d.enabled) {
          domains.push({
            url: `https://${d.domain}`,
            label: `${d.domain}  (custom domain)`,
          });
        }
      }
    }

    // Managed r2.dev subdomain
    const managedRes = await fetch(`${base}/managed`, { headers });
    if (managedRes.ok) {
      const data = (await managedRes.json()) as any;
      if (data.result?.enabled && data.result?.domain) {
        domains.push({
          url: `https://${data.result.domain}`,
          label: `${data.result.domain}  (r2.dev)`,
        });
      }
    }
  } catch { /* ignore — user can type manually */ }

  return domains;
}

function contentTypeForFile(filePath: string): string {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".m4s")) return "video/iso.segment";
  if (filePath.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

async function uploadToR2(
  accountId: string,
  bucket: string,
  key: string,
  filePath: string,
) {
  const size = statSync(filePath).size;
  const ct = contentTypeForFile(filePath);

  const proc = Bun.spawn(
    [
      "wrangler", "r2", "object", "put",
      `${bucket}/${key}`,
      "--file", filePath,
      "--content-type", ct,
      "--cache-control", "public, max-age=31536000, immutable",
      "--remote",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Upload failed for ${key}:\n${stderr}`);
}

// ─── Progress rendering ─────────────────────────────────────────────────────

const BAR_WIDTH = 30;
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const CLEAR_LINE = "\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const MAX_CONCURRENT = 2;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function renderBar(pct: number): string {
  const filled = Math.round(BAR_WIDTH * Math.min(pct, 1));
  const empty = BAR_WIDTH - filled;
  return `${GREEN}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

interface FfmpegProgress {
  frame: number;
  fps: number;
  bitrate: string;
  totalSize: number;
  outTimeUs: number;
  speed: string;
  progress: string;
}

function parseFfmpegProgress(chunk: string, state: Partial<FfmpegProgress>): FfmpegProgress {
  for (const line of chunk.split("\n")) {
    const [key, ...rest] = line.split("=");
    const val = rest.join("=").trim();
    if (!key || !val) continue;
    switch (key.trim()) {
      case "frame":       state.frame = parseInt(val) || 0; break;
      case "fps":         state.fps = parseFloat(val) || 0; break;
      case "bitrate":     state.bitrate = val; break;
      case "total_size":  state.totalSize = parseInt(val) || 0; break;
      case "out_time_us": state.outTimeUs = parseInt(val) || 0; break;
      case "speed":       state.speed = val; break;
      case "progress":    state.progress = val; break;
    }
  }
  return state as FfmpegProgress;
}

// ─── Multi-job progress display ─────────────────────────────────────────────

interface JobSlot {
  label: string;
  state: Partial<FfmpegProgress>;
  t0: number;
  durationUs: number;
  done: boolean;
  result?: string;
}

class ProgressDisplay {
  private slots: Map<number, JobSlot> = new Map();
  private lineCount = 0;
  private interval: ReturnType<typeof setInterval> | null = null;

  start() {
    process.stdout.write(HIDE_CURSOR);
    this.interval = setInterval(() => this.render(), 150);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.clearLines();
    process.stdout.write(SHOW_CURSOR);
  }

  addSlot(id: number, label: string, durationSec: number) {
    this.slots.set(id, {
      label, state: {}, t0: performance.now(),
      durationUs: durationSec * 1_000_000, done: false,
    });
  }

  updateSlot(id: number, chunk: string) {
    const slot = this.slots.get(id);
    if (slot) parseFfmpegProgress(chunk, slot.state);
  }

  finishSlot(id: number, result: string) {
    const slot = this.slots.get(id);
    if (slot) { slot.done = true; slot.result = result; }
  }

  private clearLines() {
    if (this.lineCount > 0) {
      process.stdout.write(`\x1b[${this.lineCount}A`);
      for (let i = 0; i < this.lineCount; i++) process.stdout.write(`${CLEAR_LINE}\n`);
      process.stdout.write(`\x1b[${this.lineCount}A`);
    }
  }

  private render() {
    this.clearLines();
    const lines: string[] = [];
    const activeSlots = [...this.slots.entries()].filter(([, s]) => !s.done);
    const doneSlots = [...this.slots.entries()].filter(([, s]) => s.done);

    for (const [, slot] of doneSlots) {
      if (slot.result) lines.push(slot.result);
    }

    for (const [, slot] of activeSlots) {
      const p = slot.state as FfmpegProgress;
      const now = performance.now();
      const pct = slot.durationUs > 0 ? (p.outTimeUs ?? 0) / slot.durationUs : 0;
      const elapsedSec = (now - slot.t0) / 1000;
      const eta = pct > 0.01 ? (elapsedSec / pct) * (1 - pct) : 0;

      const bar = renderBar(pct);
      const pctStr = `${(pct * 100).toFixed(1)}%`.padStart(6);
      const fpsStr = `${CYAN}${(p.fps ?? 0).toFixed(1)} fps${RESET}`;
      const frameStr = `${DIM}f:${p.frame ?? 0}${RESET}`;
      const bitrateStr = p.bitrate && p.bitrate !== "N/A"
        ? `${YELLOW}${p.bitrate}${RESET}` : `${DIM}...${RESET}`;
      const sizeStr = formatSize(p.totalSize ?? 0);
      const speedStr = p.speed && p.speed !== "N/A" ? p.speed : "...";

      lines.push(`  ${slot.label}`);
      lines.push(`      ${bar}  ${pctStr}  ${fpsStr}  ${frameStr}  ${bitrateStr}  ${sizeStr}  ${speedStr}  ${formatTime(elapsedSec)}/${DIM}ETA ${formatTime(eta)}${RESET}`);
    }

    const totalDone = doneSlots.length;
    const total = this.slots.size;
    if (total > 0) lines.push(`${DIM}  ── ${totalDone}/${total} complete ──${RESET}`);

    const output = lines.join("\n") + "\n";
    process.stdout.write(output);
    this.lineCount = lines.length;
  }
}

// ─── ffmpeg helpers ──────────────────────────────────────────────────────────

async function probeVideo(file: string): Promise<{
  width: number; height: number; duration: number;
  fps: number; codec: string; pixFmt: string; size: number;
}> {
  const out = await run([
    "ffprobe", "-v", "quiet", "-print_format", "json",
    "-show_streams", "-show_format", file,
  ]);
  const info = JSON.parse(out);
  const vs = info.streams?.find((s: any) => s.codec_type === "video");
  if (!vs) throw new Error("No video stream found");
  let fps = 0;
  if (vs.r_frame_rate) {
    const [num, den] = vs.r_frame_rate.split("/").map(Number);
    if (den) fps = num / den;
  }
  return {
    width: Number(vs.width), height: Number(vs.height),
    duration: Number(info.format?.duration ?? vs.duration ?? 0),
    fps: Math.round(fps * 100) / 100,
    codec: vs.codec_name ?? "unknown",
    pixFmt: vs.pix_fmt ?? "unknown",
    size: Number(info.format?.size ?? 0),
  };
}

interface EncodeResult {
  variantDir: string;   // local directory with segments + playlist
  dirName: string;      // e.g. "1080p_h264"
  profile: Profile;
  codec: "h264" | "h265";
  bandwidth: number;    // bits/sec (calculated from output size)
  totalBytes: number;
}

async function encode(
  src: string,
  outDir: string,
  profile: Profile,
  codec: "h264" | "h265",
  durationSec: number,
  jobId: number,
  display: ProgressDisplay,
): Promise<EncodeResult> {
  const dirName = `${profile.tag}_${codec}`;
  const variantDir = join(outDir, dirName);
  mkdirSync(variantDir, { recursive: true });

  const crf = codec === "h264" ? profile.h264Crf : profile.h265Crf;
  const maxrate = codec === "h264" ? profile.h264Maxrate : profile.h265Maxrate;
  const bufsize = codec === "h264" ? profile.h264Bufsize : profile.h265Bufsize;
  const level = codec === "h264" ? profile.h264Level : "";

  const codecArgs = codec === "h264"
    ? ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level", level]
    : ["-c:v", "libx265", "-preset", "slow", "-tag:v", "hvc1"];

  const scaleFilter = [
    `scale=min(${profile.width}\\,iw):min(${profile.height}\\,ih)`,
    ":force_original_aspect_ratio=decrease",
    ",scale=trunc(iw/2)*2:trunc(ih/2)*2",
  ].join("");

  const label = `🎬 ${BOLD}${profile.tag} ${codec.toUpperCase()}${RESET}  ${profile.width}×${profile.height}  ${DIM}crf=${crf} maxrate=${maxrate}${RESET}`;
  display.addSlot(jobId, label, durationSec);

  const playlistPath = join(variantDir, "playlist.m3u8");
  const segPattern = join(variantDir, "seg_%03d.m4s");
  const initFilename = "init.mp4";

  const args = [
    "ffmpeg", "-y",
    "-i", src,
    ...codecArgs,
    "-crf", String(crf),
    "-maxrate", maxrate,
    "-bufsize", bufsize,
    "-vf", scaleFilter,
    "-an",
    "-pix_fmt", "yuv420p",
    // Force keyframes at segment boundaries for clean cuts
    "-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION})`,
    // HLS fMP4 output
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_DURATION),
    "-hls_segment_type", "fmp4",
    "-hls_playlist_type", "vod",
    "-hls_fmp4_init_filename", initFilename,
    "-hls_segment_filename", segPattern,
    // Progress
    "-progress", "pipe:1",
    "-nostats",
    playlistPath,
  ];

  const t0 = performance.now();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  let stderrChunks: string[] = [];
  const stderrPromise = new Response(proc.stderr).text().then((t) => { stderrChunks.push(t); });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    display.updateSlot(jobId, decoder.decode(value, { stream: true }));
  }

  await stderrPromise;
  const code = await proc.exited;

  if (code !== 0) {
    display.finishSlot(jobId, `  ❌  ${profile.tag} ${codec.toUpperCase()} FAILED`);
    throw new Error(`ffmpeg exited ${code} for ${profile.tag} ${codec}\n${stderrChunks.join("")}`);
  }

  // Calculate total size of segments
  const files = readdirSync(variantDir);
  let totalBytes = 0;
  for (const f of files) {
    if (f.endsWith(".m4s") || f.endsWith(".mp4")) {
      totalBytes += statSync(join(variantDir, f)).size;
    }
  }
  const bandwidth = durationSec > 0 ? Math.round((totalBytes * 8) / durationSec) : 0;
  const elapsed = (performance.now() - t0) / 1000;
  const realtimeX = ((durationSec / elapsed) || 0).toFixed(1);

  display.finishSlot(jobId,
    `  ✅  ${profile.tag} ${codec.toUpperCase()}  ${GREEN}${formatSize(totalBytes)}${RESET}  ` +
    `${DIM}${Math.round(bandwidth / 1000)} kbps  ${elapsed.toFixed(1)}s (${realtimeX}x realtime)${RESET}`,
  );

  return { variantDir, dirName, profile, codec, bandwidth, totalBytes };
}

// ─── HLS playlist generation ────────────────────────────────────────────────

function generateMasterPlaylist(results: EncodeResult[]): string {
  // Sort by bandwidth descending so highest quality is first
  const sorted = [...results].sort((a, b) => b.bandwidth - a.bandwidth);

  let m3u8 = "#EXTM3U\n#EXT-X-VERSION:7\n\n";

  for (const r of sorted) {
    const codecStr = r.codec === "h264" ? r.profile.h264Codec : r.profile.h265Codec;
    const res = `${r.profile.width}x${r.profile.height}`;

    m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${res},CODECS="${codecStr}"\n`;
    m3u8 += `${r.dirName}/playlist.m3u8\n\n`;
  }

  return m3u8;
}

/** Collect all files in a variant directory for upload. */
function collectVariantFiles(variantDir: string, dirName: string): { localPath: string; key: string }[] {
  const files: { localPath: string; key: string }[] = [];
  for (const f of readdirSync(variantDir)) {
    const localPath = join(variantDir, f);
    if (statSync(localPath).isFile()) {
      files.push({ localPath, key: `${dirName}/${f}` });
    }
  }
  return files;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
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
  console.log(`   ${probe.width}×${probe.height}  •  ${probe.duration.toFixed(1)}s  •  ${probe.fps} fps  •  ${probe.codec}  •  ${probe.pixFmt}  •  ${formatSize(probe.size)}\n`);

  // ── Select account ──
  const { email, accounts } = await getAccounts();
  if (accounts.length === 0) {
    console.error("❌  No accounts found. Run `wrangler login` first.");
    process.exit(1);
  }
  if (email) console.log(`👤  Logged in as ${email}\n`);

  const accountId = accounts.length === 1
    ? accounts[0].id
    : await select({
        message: "Cloudflare account:",
        choices: accounts.map((a) => ({
          name: `${a.name}  (${a.id.slice(0, 8)}…)`, value: a.id,
        })),
      });
  const selectedAccount = accounts.find((a) => a.id === accountId)!;
  console.log(`   Using ${selectedAccount.name} (${accountId.slice(0, 8)}…)\n`);

  // ── Select bucket ──
  const buckets = await listBuckets(accountId);
  if (buckets.length === 0) {
    console.error("❌  No R2 buckets found in this account.");
    process.exit(1);
  }
  const bucket = await select({
    message: "R2 bucket:",
    choices: buckets.map((b) => ({ name: b, value: b })),
  });

  // ── Browse / create folder ──
  let prefix = "";
  while (true) {
    const folders = await listFolders(accountId, bucket, prefix);
    const choices: { name: string; value: string }[] = [
      { name: `📁  Use current path: /${prefix || ""}`, value: "__use__" },
      { name: "✏️   Type a new folder name", value: "__new__" },
    ];
    if (folders.length > 0) {
      for (const f of folders) {
        choices.push({ name: `📂  ${f.replace(prefix, "")}`, value: f });
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

  // ── Choose codecs ──
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

  // ── Filter profiles (don't upscale) ──
  const applicableProfiles = PROFILES.filter(
    (p) => p.width <= probe.width || p.height <= probe.height,
  );
  if (applicableProfiles.length === 0) {
    console.error("❌  Source resolution too small for any profile");
    process.exit(1);
  }

  const totalJobs = applicableProfiles.length * selectedCodecs.length;
  const r2Prefix = `${prefix}${stem}`;
  console.log(`\n📐  Profiles:  ${applicableProfiles.map((p) => p.tag).join(", ")}`);
  console.log(`🎞️   Codecs:    ${selectedCodecs.join(", ")}`);
  console.log(`📦  Dest:      r2://${bucket}/${r2Prefix}/`);
  console.log(`📊  Jobs:      ${totalJobs} HLS variants  (${HLS_SEGMENT_DURATION}s segments, fMP4)\n`);

  // ── Public base URL (for the final link) ──
  const domains = await getBucketDomains(accountId, bucket);

  let baseUrl = "";
  if (domains.length > 0) {
    const choices = [
      ...domains.map((d) => ({ name: d.label, value: d.url })),
      { name: "✏️   Enter a different URL", value: "__custom__" },
      { name: "⏭   Skip (just show R2 keys)", value: "" },
    ];
    baseUrl = await select({ message: "Public base URL:", choices });
    if (baseUrl === "__custom__") {
      baseUrl = await input({ message: "Custom base URL:" });
    }
  } else {
    console.log(`${DIM}  No public domains found on this bucket.${RESET}`);
    console.log(`${DIM}  Tip: add a custom domain or enable r2.dev in the Cloudflare dashboard.${RESET}\n`);
    baseUrl = await input({
      message: "Public base URL (or leave blank to skip):",
      default: "",
    });
  }

  const ok = await confirm({ message: "Start encoding & upload?" });
  if (!ok) process.exit(0);

  // ── Encode ──
  const tmpDir = join(import.meta.dir, ".streamaccino-tmp", stem);
  mkdirSync(tmpDir, { recursive: true });

  console.log(`\n🔧  Encoding HLS to ${tmpDir}  (${MAX_CONCURRENT} parallel)\n`);

  interface EncodeJob { profile: Profile; codec: "h264" | "h265"; jobId: number }
  const jobs: EncodeJob[] = [];
  let jobId = 0;
  for (const profile of applicableProfiles) {
    for (const codec of selectedCodecs) {
      jobs.push({ profile, codec, jobId: ++jobId });
    }
  }

  const display = new ProgressDisplay();
  display.start();

  const encodeT0 = performance.now();
  const results: EncodeResult[] = [];
  const pending = new Set<Promise<void>>();
  const errors: Error[] = [];

  for (const job of jobs) {
    const p = (async () => {
      try {
        const result = await encode(
          absInput, tmpDir, job.profile, job.codec,
          probe.duration, job.jobId, display,
        );
        results.push(result);
      } catch (err) { errors.push(err as Error); }
    })();
    pending.add(p);
    p.then(() => pending.delete(p));
    if (pending.size >= MAX_CONCURRENT) await Promise.race(pending);
  }
  await Promise.all(pending);
  display.stop();

  if (errors.length > 0) {
    for (const err of errors) console.error(err.message);
    console.error(`\n❌  ${errors.length} encoding job(s) failed`);
    process.exit(1);
  }

  const encodeElapsed = (performance.now() - encodeT0) / 1000;

  // Print results
  console.log("");
  // Sort results to match job order
  results.sort((a, b) => {
    const ai = jobs.findIndex((j) => j.profile.tag === a.profile.tag && j.codec === a.codec);
    const bi = jobs.findIndex((j) => j.profile.tag === b.profile.tag && j.codec === b.codec);
    return ai - bi;
  });

  for (const r of results) {
    const kbps = Math.round(r.bandwidth / 1000);
    console.log(
      `  ✅  ${r.profile.tag} ${r.codec.toUpperCase()}  ${GREEN}${formatSize(r.totalBytes)}${RESET}  ${DIM}${kbps} kbps avg${RESET}`,
    );
  }

  const totalSize = results.reduce((sum, r) => sum + r.totalBytes, 0);
  console.log(`\n  📊  Total: ${GREEN}${formatSize(totalSize)}${RESET} across ${results.length} variants in ${encodeElapsed.toFixed(1)}s`);

  // ── Generate master playlist ──
  const masterContent = generateMasterPlaylist(results);
  const masterPath = join(tmpDir, "master.m3u8");
  await Bun.write(masterPath, masterContent);

  console.log(`\n  📋  Master playlist:\n`);
  console.log(`${DIM}${masterContent}${RESET}`);

  // ── Upload ──
  // Collect all files to upload
  const uploads: { localPath: string; r2Key: string }[] = [];

  // Master playlist
  uploads.push({ localPath: masterPath, r2Key: `${r2Prefix}/master.m3u8` });

  // Variant files
  for (const r of results) {
    const variantFiles = collectVariantFiles(r.variantDir, r.dirName);
    for (const vf of variantFiles) {
      uploads.push({ localPath: vf.localPath, r2Key: `${r2Prefix}/${vf.key}` });
    }
  }

  console.log(`☁️   Uploading ${uploads.length} files to r2://${bucket}/${r2Prefix}/\n`);

  const uploadT0 = performance.now();
  let uploaded = 0;
  for (const { localPath, r2Key } of uploads) {
    uploaded++;
    const size = statSync(localPath).size;
    const pct = `[${uploaded}/${uploads.length}]`;
    process.stdout.write(`  ${DIM}${pct}${RESET}  ${r2Key}  ${DIM}${formatSize(size)}${RESET}`);

    try {
      await uploadToR2(accountId, bucket, r2Key, localPath);
      process.stdout.write(`  ${GREEN}✓${RESET}\n`);
    } catch (err) {
      process.stdout.write(`  ❌\n`);
      throw err;
    }
  }

  const uploadElapsed = (performance.now() - uploadT0) / 1000;
  console.log(`\n  ✅  All ${uploads.length} files uploaded in ${uploadElapsed.toFixed(1)}s`);

  // ── Final summary ──
  const masterKey = `${r2Prefix}/master.m3u8`;

  console.log(`\n${"─".repeat(60)}\n`);
  console.log(`  ${BOLD}🎉  HLS stream ready!${RESET}\n`);

  if (baseUrl) {
    const cleanBase = baseUrl.replace(/\/+$/, "");
    const masterUrl = `${cleanBase}/${masterKey}`;
    console.log(`  ${BOLD}Master playlist:${RESET}`);
    console.log(`  ${CYAN}${masterUrl}${RESET}\n`);
    console.log(`  ${DIM}hls.js usage:${RESET}`);
    console.log(`  ${DIM}const hls = new Hls();${RESET}`);
    console.log(`  ${DIM}hls.loadSource("${masterUrl}");${RESET}`);
    console.log(`  ${DIM}hls.attachMedia(document.querySelector("video"));${RESET}\n`);
  } else {
    console.log(`  ${BOLD}R2 key:${RESET}  ${masterKey}\n`);
    console.log(`  ${DIM}Set a public custom domain on your bucket, then use:${RESET}`);
    console.log(`  ${DIM}https://<your-domain>/${masterKey}${RESET}\n`);
  }

  console.log(`  ${DIM}Variants:${RESET}`);
  for (const r of results) {
    const kbps = Math.round(r.bandwidth / 1000);
    console.log(`    ${r.dirName}/playlist.m3u8  ${DIM}(${r.profile.width}×${r.profile.height}, ${kbps} kbps)${RESET}`);
  }

  console.log(`\n${"─".repeat(60)}`);

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
