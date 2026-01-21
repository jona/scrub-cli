# Scrub

Convert YouTube videos into comprehensive markdown summaries. Perfect for quickly reviewing educational content, creating reference documentation, and building a personal knowledge base.

## Features

- **Smart Transcription**: Multiple transcription adapters with automatic fallback
  - Local Whisper (whisper.cpp) - default, privacy-first
  - Faster-Whisper (Python) - optimized performance
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
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY
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

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional - for API-based transcription
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...

# Optional - custom paths
SCRUB_OUTPUT_DIR=./output
SCRUB_CACHE_DIR=./cache
```

### Configuration File (optional)

Create `scrub.config.json` (or `.scrubrc.json`) for persistent settings:

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
  -o, --output <path>       Output file path (default: ./output/{title}.md)
  -t, --transcriber <name>  Force specific transcriber
  --no-visuals              Skip visual analysis (faster, cheaper)
  --scene-threshold <n>     Scene detection sensitivity (default: 0.4)
  --max-frames <n>          Maximum frames to analyze (default: 20)
  -v, --verbose             Show detailed progress
  --dry-run                 Check prerequisites without processing
  -h, --help                Display help
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
```

### Diagnostic Commands

```bash
# Check system prerequisites
scrub doctor

# List available transcription adapters
scrub transcribers
```

## MCP Integration

Scrub can be used as an MCP (Model Context Protocol) server, allowing AI agents to extract content from YouTube videos for context, skills, and knowledge building.

### Installation

```bash
# 1. Build scrub
npm run build

# 2. Verify prerequisites are available
scrub doctor

# 3. Add to your MCP client (e.g., Claude Desktop, Cursor, etc.)
# See Manual MCP Configuration below
```

### Available Tools

Once configured, MCP clients have access to these tools:

| Tool                | Description                                   |
| ------------------- | --------------------------------------------- |
| `scrub_video`       | Process a YouTube URL into structured content |
| `scrub_doctor`      | Check system prerequisites and configuration  |
| `list_transcribers` | Show available transcription backends         |

### Usage Examples

Agents can use scrub like this:

```
# Extract video content for context
scrub_video("https://youtube.com/watch?v=VIDEO_ID")

# Get just the transcript
scrub_video("https://youtube.com/watch?v=VIDEO_ID", outputFormat="transcript")

# Fast processing without visual analysis
scrub_video("https://youtube.com/watch?v=VIDEO_ID", skipVisuals=true)

# Check system status
scrub_doctor()
```

### Output Formats

The `scrub_video` tool supports three output formats:

- **summary** (default): Overview, sections with timestamps, key takeaways, code snippets
- **transcript**: Raw transcript with timestamps - useful for detailed analysis
- **full**: Complete ProcessResult with all metadata - for programmatic use

### Manual MCP Configuration

Add this to your MCP client configuration (e.g., `~/.cursor/mcp.json` for Cursor, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "scrub": {
      "command": "node",
      "args": ["/path/to/scrub/dist/entrypoints/mcp/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Or if installed globally via `npm link`:

```json
{
  "mcpServers": {
    "scrub": {
      "command": "scrub-mcp",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
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

Adapters are tried in priority order. Set your preference in `scrub.config.json`.

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
- Set `OPENAI_API_KEY` for cloud transcription

### "Anthropic API key not configured"

```bash
# Create .env file from template
cp .env.example .env

# Edit .env and add your API key
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Video download fails

- Check if the video is age-restricted or private
- Update yt-dlp: `pip install -U yt-dlp`
- Some videos may be geo-restricted

## Project Structure

```
src/
  entrypoints/           # Driving adapters (how users access the app)
    cli/                 # Command-line interface (Commander.js)
    mcp/                 # Model Context Protocol server for AI agents

  core/                  # Domain orchestration
    VideoProcessor.ts    # Main processing pipeline coordinator

  services/              # Domain services (business logic)
    Summarizer.ts        # Claude-powered content summarization
    VisualAnalyzer.ts    # Frame analysis with Claude Vision
    SceneDetector.ts     # FFmpeg-based scene change detection
    MarkdownGenerator.ts # Output formatting

  adapters/              # Driven adapters (external integrations)
    transcription/       # Speech-to-text adapters
      ITranscriber.ts    # Interface for all transcribers
      TranscriberFactory.ts
      LocalWhisperAdapter.ts
      FasterWhisperAdapter.ts
      OpenAIWhisperAdapter.ts
      DeepgramAdapter.ts
      YouTubeCaptionsAdapter.ts
    download/            # Video acquisition
      VideoDownloader.ts # yt-dlp wrapper

  infrastructure/        # Cross-cutting concerns
    Config.ts            # Configuration management

  utils/                 # Shared utilities
  types/                 # TypeScript type definitions
```

The architecture follows **Hexagonal (Ports & Adapters)** patterns:

- **Entrypoints** handle protocol-specific concerns (CLI args, MCP JSON-RPC)
- **Core** contains protocol-agnostic business logic
- **Adapters** isolate external dependencies behind interfaces

## Development

```bash
# Run in development mode
npm run dev -- https://youtube.com/watch?v=xyz

# Type checking
npm run typecheck

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
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Model Context Protocol integration
