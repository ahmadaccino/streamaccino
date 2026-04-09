# streamaccino

Hero video encoder & Cloudflare R2 uploader.

Encodes a source video into a bitrate ladder optimised for short (≤30s) hero/background videos on the web, then uploads every rendition to Cloudflare R2.

## Install

```bash
brew install ahmadaccino/tap/streamaccino
```

Or download a binary from [Releases](https://github.com/ahmadaccino/streamaccino/releases).

## Usage

```bash
streamaccino <video-file>
```

The interactive CLI will walk you through:

1. Selecting your Cloudflare account
2. Choosing an R2 bucket and destination folder
3. Picking codecs (H.264, H.265, or both)
4. Encoding with a parallel progress display
5. Uploading all renditions to R2

### Encoding profiles

| Profile | Resolution | H.264 CRF / Max | H.265 CRF / Max |
|---------|-----------|-----------------|-----------------|
| 2160p   | 3840×2160 | 23 / 12M        | 26 / 8M         |
| 1080p   | 1920×1080 | 22 / 5M         | 25 / 3M         |
| 720p    | 1280×720  | 23 / 3M         | 26 / 1.8M       |
| 480p    | 854×480   | 24 / 1.5M       | 27 / 900k       |

Profiles larger than the source resolution are automatically skipped (no upscaling).

## Requirements

- [ffmpeg](https://ffmpeg.org/) and ffprobe on PATH
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) on PATH, authenticated (`wrangler login`)

## Development

```bash
bun install
bun run upload.ts <video-file>
```

### Build binaries

```bash
bun run build.ts      # builds for all platforms → dist/
bun run release.ts    # builds, tars, generates Homebrew formula
```

## License

MIT
