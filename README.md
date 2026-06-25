# Scrub

![Scrub Banner](https://www.scrb.dev/og-banner.jpg)

Turn YouTube videos and local audio/video files into **deterministic, model-agnostic knowledge artifacts** in seconds. Scrub does the deterministic work — download, transcribe, extract key frames, and assemble a ready-to-send summary prompt — and emits artifacts. An agent harness (Claude Code, another CLI, your own app) takes those artifacts and runs whatever model it wants. **Scrub calls no LLM and has no model dependency.**

## Features

- **Smart Transcription**: Multiple transcription adapters with automatic fallback
  - Faster-Whisper (Python) - default, optimized performance
  - Local Whisper (whisper.cpp) - privacy-first
  - OpenAI Whisper API - cloud-based
  - Deepgram API - enterprise-grade
  - YouTube Captions - fallback when no transcription available

- **Frame Extraction**: Intelligent scene detection captures key frames
  - Smart scene change detection (not periodic snapshots)
  - Emits frames + a `frames.json` manifest of timestamps
  - A harness can run its own vision model over the frames

- **Prompt Assembly**: The deterministic half of summarization, model-free
  - Builds a `summary.prompt.md` with the transcript, metadata, and visuals interpolated
  - Emits a `summary.schema.json` describing the expected JSON output
  - `scrub render` turns a model's JSON response back into polished markdown

- **Playlist Support**: Process entire YouTube playlists
  - Configurable concurrency for parallel processing
  - Skip existing videos or reprocess as needed
  - Limit number of videos to process

- **Local Media**: Process `.mp3` and `.mp4` files via `scrub file`
  - Frame extraction skipped automatically for audio-only files

- **Composable CLI**: Run the full pipeline or individual steps (`download`, `prepare`, `transcribe`, `extract-frames`, `prompt`, `render`)

- **Artifact Caching**: Smart caching system
  - Caches transcriptions and frames
  - Reuses cached data for faster reprocessing

## Prerequisites

### Required

1. **Node.js 18+**

   ```bash
   node --version  # Should be 18.0.0 or higher
   ```

2. **yt-dlp** (video download)

   ```bash
   # macOS
   brew install yt-dlp

   # Linux/Windows
   pip install yt-dlp
   ```

3. **ffmpeg** (audio/video processing)

   ```bash
   # macOS
   brew install ffmpeg

   # Linux
   sudo apt install ffmpeg
   ```

4. **User config** at `~/.scrub/config.json` (optional)

   No API key is required — scrub calls no LLM. A config file is only needed to
   set a hosted transcription key (OpenAI/Deepgram) or tweak defaults. Local
   transcription (whisper.cpp / faster-whisper) needs no key at all.

   ```bash
   mkdir -p ~/.scrub
   ```

   Run `scrub doctor` to verify tools and transcription adapters.

### Optional (for local transcription)

5. **whisper.cpp** (recommended for local transcription)

   ```bash
   # Clone and build
   git clone https://github.com/ggerganov/whisper.cpp
   cd whisper.cpp
   make

   # Download a model
   bash ./models/download-ggml-model.sh base
   ```

   Or **faster-whisper** (Python):

   ```bash
   pip install faster-whisper
   ```

   Point whisper.cpp at your install in config:

   ```json
   {
     "localWhisper": {
       "binaryPath": "~/whisper.cpp/main",
       "modelsPath": "~/whisper.cpp/models"
     }
   }
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/scrub.git
cd scrub

# Install dependencies
npm install

# Build
npm run build

# (Optional) Link globally
npm link
```

## Configuration

### User Configuration

Scrub reads all persistent configuration from `~/.scrub/config.json`. This file lives outside the repository and holds API keys, output/cache paths, and adapter settings. Environment variables and repo-local config files are not used.

Default output directory is `~/.scrub/docs`. Artifacts are stored in slugified subdirectories (e.g. `how-to-build-agents/`).

```json
{
  "transcription": {
    "priority": [
      "faster-whisper",
      "local-whisper",
      "openai",
      "youtube-captions"
    ],
    "whisperModel": "base",
    "language": "en"
  },
  "visual": {
    "enabled": true,
    "sceneThreshold": 0.4,
    "maxFrames": 20
  },
  "output": {
    "directory": "~/.scrub/docs",
    "includeFullTranscript": false
  },
  "cache": {
    "directory": ".cache"
  },
  "localWhisper": {
    "binaryPath": "/path/to/whisper.cpp/main",
    "modelsPath": "/path/to/whisper.cpp/models"
  },
  "apis": {
    "openai": "sk-...",
    "deepgram": "..."
  }
}
```

Paths may use `~` for your home directory. Override output per run with `-o, --output-dir` on `scrub youtube` and `scrub file`.

## Usage

### Full pipeline (orchestrators)

```bash
# YouTube video or playlist
scrub youtube https://www.youtube.com/watch?v=VIDEO_ID

# Local .mp3 or .mp4
scrub file ./recording.mp4

# Development (from repo)
npm run dev -- youtube https://www.youtube.com/watch?v=VIDEO_ID
```

**`scrub youtube <url>` options:**

| Flag | Description |
|------|-------------|
| `-o, --output-dir <path>` | Override artifact/output directory |
| `-t, --transcriber <name>` | Force adapter (`local-whisper`, `faster-whisper`, `openai`, `deepgram`, `youtube-captions`) |
| `--no-visuals` | Skip frame extraction |
| `--scene-threshold <n>` | Scene detection sensitivity (default: 0.4) |
| `--max-frames <n>` | Max frames to extract (default: 20) |
| `-v, --verbose` | Detailed progress |
| `--max-videos <n>` | Limit playlist videos processed |
| `--parallel <n>` | Concurrent playlist jobs (default: 1) |
| `--no-skip-existing` | Reprocess cached videos |

**`scrub file <path>`** supports the same flags except playlist options. Frame extraction is skipped for `.mp3`.

### Examples

```bash
# YouTube video
scrub youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ

# Custom output directory
scrub youtube https://youtu.be/abc123 -o ./notes

# Skip frame extraction (faster)
scrub youtube https://youtube.com/watch?v=xyz --no-visuals

# Force OpenAI transcription
scrub youtube https://youtube.com/watch?v=xyz -t openai

# Playlist: first 5 videos, 2 in parallel
scrub youtube https://youtube.com/playlist?list=PLxyz --max-videos 5 --parallel 2

# Reprocess cached playlist entries
scrub youtube https://youtube.com/playlist?list=PLxyz --no-skip-existing

# Local file
scrub file ./podcast.mp3
```

### Primitives (pipeline steps)

Run individual steps for scripting or debugging:

```bash
scrub download <youtube-url> [-o ./download] [--no-video]
scrub prepare <local.mp3|mp4> [-o ./prepare] [--no-video]
scrub transcribe <audio.wav> [-o ./transcript.json] [-t openai] [--text]
scrub extract-frames <video.mp4> [-o ./frames.json] [--output-dir ./frames]
scrub prompt <file> [-o ./summary.prompt.md] [--schema ./summary.schema.json] [--metadata path] [--visuals path]
scrub render <summary.json> [-o ./summary.md] [--metadata path] [--transcript path]
```

`prompt` accepts `.json` transcripts, plain `.txt`, `.md`, and other text sources, and
emits the assembled prompt + output schema. Send the prompt to any model, then
`scrub render` the model's JSON response into markdown.

### Agent harness round-trip

```bash
# 1. Scrub does the deterministic work
scrub youtube https://youtube.com/watch?v=xyz -o ./out

# 2. The harness sends the assembled prompt to whatever model it wants
cat ./out/<slug>/prompt/summary.prompt.md | <your-model> > ./out/<slug>/inference/summary.json

# 3. Scrub renders the model's JSON back into polished markdown
scrub render ./out/<slug>/inference/summary.json -o ./out/<slug>/output/summary.md
```

### Diagnostic commands

```bash
# Check tools, config path, optional transcription keys, and adapters
scrub doctor

# List transcription adapters and availability
scrub transcribers
```

`scrub doctor` exits with code 1 when requirements are missing.

## Output Format

`scrub render` turns a model's summary JSON into markdown files that include:

````markdown
# Video Title

> **Source:** [YouTube URL](YouTube URL)
> **Channel:** Channel Name
> **Duration:** 10:30
> **Processed:** 2026-01-20

## Overview

Brief 2-3 sentence summary...

## Table of Contents

1. [Introduction](#introduction) (0:00)
2. [Main Topic](#main-topic) (2:30)
   ...

## Content

### Introduction (0:00 - 2:30)

Summary of this section...

**Visual Content:** Description of slides/diagrams shown

---

### Main Topic (2:30 - 5:00)

...

## Key Takeaways

- Point 1
- Point 2

## Code Snippets

**Context description** (2:30)

```python
# Code shown in the video
```
````

## References & Resources

- Mentioned tools and resources
- https://example.com/linked-resource

---

_Generated by [Scrub](https://github.com/yourusername/scrub) on 2026-01-20T12:00:00.000Z_

````

## Cost Estimates

Scrub itself calls **no LLM**, so the tool has no model cost. Its only optional
cost is hosted transcription:

| Component | Cost |
|-----------|------|
| Video download | Free |
| Local transcription (whisper.cpp / faster-whisper) | Free |
| Hosted transcription (OpenAI / Deepgram) | ~$0.006–0.007/min |
| Frame extraction (ffmpeg) | Free |
| Prompt assembly | Free |

Summarization and vision are the **agent harness's** responsibility — their cost
depends on the model the harness chooses to run against the emitted prompt/frames.

## Transcription Adapters

| Adapter | Requires | Cost | Speed | Quality |
|---------|----------|------|-------|---------|
| local-whisper | whisper.cpp | Free | Medium | Good |
| faster-whisper | Python + GPU | Free | Fast | Good |
| openai | API Key | $0.006/min | Fast | Excellent |
| deepgram | API Key | ~$0.007/min | Very Fast | Excellent |
| youtube-captions | Nothing | Free | Instant | Varies |

Adapters are tried in priority order. Set your preference in `~/.scrub/config.json`.

## Troubleshooting

### "yt-dlp not found"

```bash
# macOS
brew install yt-dlp

# Or with pip
pip install yt-dlp
```

### "ffmpeg not found"

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### "No transcription adapters available"

Install at least one transcription option:

- whisper.cpp (recommended)
- faster-whisper (`pip install faster-whisper`)
- Add `apis.openai` to `~/.scrub/config.json` for cloud transcription

### Video download fails

- Check if the video is age-restricted or private
- Update yt-dlp: `pip install -U yt-dlp`
- Some videos may be geo-restricted

## Project Structure

```
src/
  entrypoints/cli/       # Commander.js + Ink (orchestrators + primitives)

  orchestrators/         # End-to-end pipelines
    youtube.ts           # YouTube video / playlist processing
    file.ts              # Local .mp3 / .mp4 processing

  core/                  # Pure pipeline primitives (no LLM)
    download.ts          # yt-dlp download + metadata
    prepare.ts           # Local file audio extraction + metadata
    transcribe.ts        # Transcription entrypoint
    extract-frames.ts    # Scene detection + ffmpeg frame extraction
    summary-template.ts  # buildSummaryPrompt + SUMMARY_SCHEMA + renderSummaryMarkdown
    prompt.ts            # Assemble summary.prompt.md + summary.schema.json
    render.ts            # Render a model's summary JSON into markdown

  services/              # Shared domain services
    ArtifactStore.ts     # Slug-based artifact layout and caching
    PlaylistExtractor.ts # Playlist metadata

  transcription/         # Speech-to-text adapters + factory fallback
  infrastructure/        # ~/.scrub/config.json loading (Config.ts)
  utils/                 # Logging, ffmpeg helpers
  types/                 # Shared TypeScript types
```

Architecture is a **three-layer** layout:

- **Entrypoints** — CLI parsing, progress UI, and wiring flags into config
- **Orchestrators** — compose primitives into full YouTube or local-file runs
- **Core** — stateless functions callable from CLI primitives or orchestrators

## Development

```bash
# Run in development mode
npm run dev -- youtube https://youtube.com/watch?v=xyz

# Type checking
npm run typecheck

# Run tests
npm test

# Build for production
npm run build

# Clean build artifacts
npm run clean
```

## License

MIT

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - Video downloading
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) - Local speech recognition
- [faster-whisper](https://github.com/guillaumekln/faster-whisper) - Optimized Whisper
- [ffmpeg](https://ffmpeg.org/) - Audio/video processing and frame extraction
