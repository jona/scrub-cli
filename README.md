# Scrub

![Scrub Banner](https://www.scrb.dev/og-banner.jpg)

Turn YouTube videos into comprehensive summaries and Agent Skills in seconds. Perfect for quickly reviewing educational content, creating reference documentation, building a personal knowledge base, and generating reusable skills for AI agents.

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

4. **Anthropic API Key** (for Claude summarization + vision)
   ```bash
   mkdir -p ~/.scrub
   # Add your API keys to ~/.scrub/config.json
   ```

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

Scrub reads all persistent configuration from `~/.scrub/config.json`. This file lives outside the repository and can contain local API keys and machine-specific paths.

```json
{
  "transcription": {
    "priority": [
      "local-whisper",
      "faster-whisper",
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
    "model": "claude-opus-4-5-20251101"
  },
  "output": {
    "directory": "./output",
    "includeFullTranscript": false
  },
  "cache": {
    "directory": "./cache"
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

## Usage

### Basic Usage

```bash
# Process a YouTube video
scrub https://www.youtube.com/watch?v=VIDEO_ID

# Or use npm run
npm run dev -- https://www.youtube.com/watch?v=VIDEO_ID
```

### Options

```bash
scrub <url> [options]

Options:
  -o, --output <path>          Output file path (default: ./output/{title}.md)
  -t, --transcriber <name>     Force specific transcriber
  --no-visuals                 Skip visual analysis (faster, cheaper)
  --scene-threshold <n>        Scene detection sensitivity (default: 0.4)
  --max-frames <n>             Maximum frames to analyze (default: 20)
  --output-skill               Generate SKILL.md from video content
  --skill-name <name>          Custom skill name (auto-derived if not provided)
  -v, --verbose                Show detailed progress
  --dry-run                    Check prerequisites without processing
  --max-videos <number>        Maximum videos to process from playlist
  --parallel <number>          Process N videos in parallel (default: 1)
  --no-skip-existing           Reprocess videos that already exist
  -h, --help                   Display help
```

### Examples

```bash
# Basic processing
scrub https://www.youtube.com/watch?v=dQw4w9WgXcQ

# Save to specific file
scrub https://youtu.be/abc123 -o ./notes/react-hooks.md

# Skip visual analysis (faster, cheaper)
scrub https://youtube.com/watch?v=xyz --no-visuals

# Force OpenAI transcription
scrub https://youtube.com/watch?v=xyz -t openai

# Verbose output
scrub https://youtube.com/watch?v=xyz -v

# Generate an Agent Skill from video
scrub https://youtube.com/watch?v=xyz --output-skill

# Generate skill with custom name
scrub https://youtube.com/watch?v=xyz --output-skill --skill-name "react-hooks"

# Process a playlist (first 5 videos, 2 in parallel)
scrub https://youtube.com/playlist?list=PLxyz --max-videos 5 --parallel 2

# Reprocess existing videos in a playlist
scrub https://youtube.com/playlist?list=PLxyz --no-skip-existing
```

### Diagnostic Commands

```bash
# Check system prerequisites
scrub doctor

# List available transcription adapters
scrub transcribers
```

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
````

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
  entrypoints/           # Driving adapters (how users access the app)
    cli/                 # Command-line interface (Commander.js + Ink)

  core/                  # Domain orchestration
    VideoProcessor.ts    # Main processing pipeline for single videos
    PlaylistProcessor.ts # Orchestrates playlist processing with parallelism

  services/              # Domain services (business logic)
    Summarizer.ts        # Claude-powered content summarization
    VisualAnalyzer.ts    # Frame analysis with Claude Vision
    SceneDetector.ts     # FFmpeg-based scene change detection
    MarkdownGenerator.ts # Output formatting
    SkillGenerator.ts    # Agent Skill generation from video content
    VideoDownloader.ts   # yt-dlp wrapper for video acquisition
    ArtifactStore.ts     # Persistent artifact storage and caching
    PlaylistExtractor.ts # YouTube playlist metadata extraction

  transcription/         # Speech-to-text system
    ITranscriber.ts      # Interface for all transcribers
    TranscriberFactory.ts # Factory with priority ordering and fallback
    adapters/            # Individual adapter implementations
      LocalWhisperAdapter.ts
      FasterWhisperAdapter.ts
      OpenAIWhisperAdapter.ts
      DeepgramAdapter.ts
      YouTubeCaptionsAdapter.ts

  infrastructure/        # Cross-cutting concerns
    Config.ts            # Configuration management (env vars + config files)

  utils/                 # Shared utilities
    logger.ts            # Logging utilities
    helpers.ts           # Helper functions

  types/                 # TypeScript type definitions
    index.ts             # Comprehensive type definitions
```

The architecture follows **Hexagonal (Ports & Adapters)** patterns:

- **Entrypoints** handle protocol-specific concerns (CLI args)
- **Core** contains protocol-agnostic business logic
- **Services** implement domain logic (summarization, visual analysis, etc.)
- **Transcription** isolates speech-to-text behind a factory pattern
- **Infrastructure** handles cross-cutting concerns like configuration

## Development

```bash
# Run in development mode
npm run dev -- https://youtube.com/watch?v=xyz

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
