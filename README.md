# Watcher

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
git clone https://github.com/your-username/watcher.git
cd watcher

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
WATCHER_OUTPUT_DIR=./output
WATCHER_CACHE_DIR=./cache
```

### Configuration File (optional)

Create `watcher.config.json` for persistent settings:

```json
{
  "transcription": {
    "priority": ["local-whisper", "faster-whisper", "openai", "youtube-captions"],
    "whisperModel": "base",
    "language": "en"
  },
  "visual": {
    "enabled": true,
    "sceneThreshold": 0.4,
    "maxFrames": 20,
    "model": "claude-sonnet-4-20250514"
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
watcher https://www.youtube.com/watch?v=VIDEO_ID

# Or use npm run
npm run dev -- https://www.youtube.com/watch?v=VIDEO_ID
```

### Options

```bash
watcher <url> [options]

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
watcher https://www.youtube.com/watch?v=dQw4w9WgXcQ

# Save to specific file
watcher https://youtu.be/abc123 -o ./notes/react-hooks.md

# Skip visual analysis (faster, cheaper)
watcher https://youtube.com/watch?v=xyz --no-visuals

# Force OpenAI transcription
watcher https://youtube.com/watch?v=xyz -t openai

# Verbose output
watcher https://youtube.com/watch?v=xyz -v
```

### Diagnostic Commands

```bash
# Check system prerequisites
watcher doctor

# List available transcription adapters
watcher transcribers
```

## Output Format

Generated markdown files include:

```markdown
# Video Title

> **Source:** YouTube URL
> **Channel:** Channel Name
> **Duration:** 10:30

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

### Main Topic (2:30 - 5:00)
...

## Key Takeaways
- Point 1
- Point 2

## Code Snippets
```python
# Code shown in the video
```

## References
- Mentioned tools and resources
```

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

Adapters are tried in priority order. Set your preference in `watcher.config.json`.

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
