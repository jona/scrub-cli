# Scrub

![Scrub Banner](https://www.scrb.dev/og-banner.jpg)

Turn YouTube videos and local audio/video files into comprehensive summaries and Agent Skills in seconds. Perfect for quickly reviewing educational content, creating reference documentation, building a personal knowledge base, and generating reusable skills for AI agents.

## Features

- **Smart Transcription**: Multiple transcription adapters with automatic fallback
  - Faster-Whisper (Python) - default, optimized performance
  - Local Whisper (whisper.cpp) - privacy-first
  - OpenAI Whisper API - cloud-based
  - Deepgram API - enterprise-grade
  - YouTube Captions - fallback when no transcription available

- **Visual Analysis**: Intelligent scene detection captures key frames
  - Smart scene change detection (not periodic snapshots)
  - Claude Vision API analyzes slides, code, diagrams
  - Extracts text/code from visual content

- **AI Summarization**: Structured markdown output
  - Section-by-section breakdown with timestamps
  - Key takeaways and bullet points
  - Code snippet extraction and consolidation
  - References and resource links
  - Comprehensive analysis (thesis, claims, mental models, bias analysis)

- **Skill Generation**: Create Agent Skills from video content
  - Generate SKILL.md files for AI agent consumption
  - Includes examples, workflows, and templates
  - Skill checklist to assess coverage

- **Playlist Support**: Process entire YouTube playlists
  - Configurable concurrency for parallel processing
  - Skip existing videos or reprocess as needed
  - Limit number of videos to process

- **Local Media**: Process `.mp3` and `.mp4` files via `scrub file`
  - Visual analysis skipped automatically for audio-only files

- **Composable CLI**: Run the full pipeline or individual steps (`download`, `prepare`, `transcribe`, `analyze-visuals`, `summarize`)

- **Artifact Caching**: Smart caching system
  - Caches transcriptions, summaries, and visual analysis
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

4. **User config** at `~/.scrub/config.json` (Anthropic API key required for summarization and vision)

   ```bash
   mkdir -p ~/.scrub
   ```

   Create `~/.scrub/config.json` with at least:

   ```json
   {
     "apis": {
       "anthropic": "sk-ant-your-key-here"
     }
   }
   ```

   Run `scrub doctor` to verify tools, API keys, and transcription adapters.

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
    "maxFrames": 20,
    "model": "claude-opus-4-6"
  },
  "summarizer": {
    "model": "claude-opus-4-6"
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
    "anthropic": "sk-ant-...",
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
| `--no-visuals` | Skip visual analysis |
| `--scene-threshold <n>` | Scene detection sensitivity (default: 0.4) |
| `--max-frames <n>` | Max frames to analyze (default: 20) |
| `--skill` | Generate `SKILL.md` alongside markdown output |
| `--skill-name <name>` | Custom skill name |
| `-v, --verbose` | Detailed progress |
| `--max-videos <n>` | Limit playlist videos processed |
| `--parallel <n>` | Concurrent playlist jobs (default: 1) |
| `--no-skip-existing` | Reprocess cached videos |

**`scrub file <path>`** supports the same flags except playlist options. Visual analysis is skipped for `.mp3`.

### Examples

```bash
# YouTube video
scrub youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ

# Custom output directory
scrub youtube https://youtu.be/abc123 -o ./notes

# Skip visual analysis (faster, cheaper)
scrub youtube https://youtube.com/watch?v=xyz --no-visuals

# Force OpenAI transcription
scrub youtube https://youtube.com/watch?v=xyz -t openai

# Generate an Agent Skill
scrub youtube https://youtube.com/watch?v=xyz --skill --skill-name react-hooks

# Playlist: first 5 videos, 2 in parallel
scrub youtube https://youtube.com/playlist?list=PLxyz --max-videos 5 --parallel 2

# Reprocess cached playlist entries
scrub youtube https://youtube.com/playlist?list=PLxyz --no-skip-existing

# Local file
scrub file ./podcast.mp3 --skill
```

### Primitives (pipeline steps)

Run individual steps for scripting or debugging:

```bash
scrub download <youtube-url> [-o ./download] [--no-video]
scrub prepare <local.mp3|mp4> [-o ./prepare] [--no-video]
scrub transcribe <audio.wav> [-o ./transcript.json] [-t openai] [--text]
scrub analyze-visuals <video.mp4> [-o ./visual_analysis.json]
scrub summarize <file> [-o ./summary.json] [--markdown] [--skill] [--metadata path] [--visuals path]
```

`summarize` accepts `.json` transcripts, plain `.txt`, `.md`, and other text sources.

### Diagnostic commands

```bash
# Check tools, config path, API keys (pings Anthropic when configured), adapters
scrub doctor

# List transcription adapters and availability
scrub transcribers
```

`scrub doctor` exits with code 1 when requirements are missing.

## Output Format

Generated markdown files include:

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

| Component | 10-min video | 30-min video |
|-----------|--------------|--------------|
| Video download | Free | Free |
| Local transcription | Free | Free |
| Claude Vision (~15 frames) | ~$0.07 | ~$0.15 |
| Claude summarization | ~$0.05 | ~$0.10 |
| **Total** | **~$0.12** | **~$0.25** |

*Costs are approximate and depend on video complexity.*

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

### "Anthropic API key not configured"

```bash
# Create the user config directory
mkdir -p ~/.scrub

# Edit ~/.scrub/config.json and set:
# { "apis": { "anthropic": "sk-ant-your-key-here" } }
```

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

  core/                  # Pure pipeline primitives
    download.ts          # yt-dlp download + metadata
    prepare.ts           # Local file audio extraction + metadata
    transcribe.ts        # Transcription entrypoint
    analyze-visuals.ts   # Scene detection + Claude Vision
    summarize.ts         # Summarization, markdown, and skill generation

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
- [Anthropic Claude](https://www.anthropic.com/) - AI summarization and vision
