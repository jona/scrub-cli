# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-04

### Added

- Shared, environment-agnostic processing pipeline with injected storage, media, model, and runtime adapters.
- Persistent background jobs through an authenticated HTTP API and MCP tools, with status, paginated results, artifact downloads, cancellation, and retry.
- Standalone Node hosts for the HTTP API, MCP over HTTP, and MCP over stdio.
- Model-agnostic `prompt`, `render`, and `extract-frames` CLI commands with structured prompt, schema, and frame artifacts.
- Configurable OpenAI-compatible and Anthropic vision and summary providers, validated output, and model usage artifacts.
- Optional LangSmith tracing with server-side credentials, redacted metadata, and explicit opt-in for prompt and response capture.
- Bounded, redacted native download diagnostics with operation, exit status, timing, and stderr details.
- Automatic refresh of the image's hash-locked yt-dlp requirement before container builds.

### Changed

- **Breaking:** The CLI defaults to deterministic preprocessing; use `--summarize` to opt in to vision, summary generation, and Markdown rendering.
- **Breaking:** Reorganized library exports around the shared pipeline and CLI, API, MCP, and local application interfaces; retired superseded document APIs.
- **Breaking:** Require Node.js 22.13.0 or newer and update provider and MCP SDKs.
- Keep the shared core, application services, entry points, and deployment composition separate within one npm package.
- Reuse durable stage checkpoints and completed model results across interrupted runs and retries.
- Configure concurrency per request and runner, with an optional application-wide cap in the runtime layer.
- Process long transcripts through bounded chunking and note compression, with configurable model budgets and output-token recovery.
- Container builds retain native media tooling, model configuration, and runtime-selected entry points.

### Fixed

- Keep successful videos and their artifacts intact when retrying failed playlist members.
- Bound frame sampling to the source timeline and avoid timestamps beyond the media duration.
- Bound metadata output and stream native command diagnostics without allowing progress output to exhaust log buffers.
- Make the compiled CLI executable after building.

### Removed

- Legacy `analyze-visuals` and `summarize` CLI commands; use `--summarize` for integrated inference or `prompt` and `render` with an external model.
- Unused Rivet runtime adapters, deployment tooling, image packaging, and their dependency tree.

## [0.2.1] - 2026-05-25

### Changed

- **Configuration** now loads exclusively from `~/.scrub/config.json` (API keys, output/cache paths, local Whisper binary and model paths)
- `scrub doctor` pings the Anthropic API when a key is configured and exits non-zero when requirements are missing
- Summary and skill generation use the Anthropic streaming API to avoid timeouts on large responses
- Generated `SKILL.md` is written beside the output markdown file instead of the current working directory

### Removed

- `dotenv` dependency and `.env.example` — use `apis.*` and path settings in `~/.scrub/config.json` instead of environment variables
- Repo-local `scrub.config.json` / `.scrubrc.json` discovery — user config lives only under `~/.scrub/`

## [0.2.0] - 2026-03-30

### Changed

- **Three-layer architecture**: pure primitives, orchestrators, and thin CLI shell (inspired by Sumi CLI patterns)
- **Renamed types**: `VideoMetadata` to `MediaMetadata`, `videoId` to `contentId`, `DownloadResult` to `PrepareResult`
- **CLI subcommands**: `scrub youtube`, `scrub file`, plus primitives (`scrub download`, `scrub prepare`, `scrub transcribe`, `scrub analyze-visuals`, `scrub summarize`)
- **Consolidated summarize**: merged Summarizer, MarkdownGenerator, and SkillGenerator into a single `summarize` primitive with `--markdown` and `--skill` flags
- `summarize` now accepts any file type (`.json`, `.txt`, `.md`) not just transcripts
- **Default output directory** moved from `./output` to `~/.scrub/docs` (global, per-user)
- **Slugified output dirs**: artifact directories now use title-based slugs (e.g. `how-to-build-agents/`) instead of sequential numbers
- YouTube metadata is now pre-fetched before download to avoid a redundant yt-dlp call

### Added

- Local `.mp3` and `.mp4` file support via `scrub file <path>` orchestrator and `scrub prepare` primitive
- `src/core/prepare.ts` — ffmpeg-based audio extraction and metadata generation for local files
- `src/orchestrators/file.ts` — full pipeline for local media files
- Visual analysis automatically skipped for `.mp3` files
- Deterministic content IDs for local files (`local-` + sha256 hash)
- `-o, --output-dir <path>` flag on `scrub youtube` and `scrub file` to override the default output directory

### Removed

- `VideoProcessor`, `PlaylistProcessor`, `VideoDownloader`, `MarkdownGenerator`, `SkillGenerator`, `SceneDetector`, `VisualAnalyzer`, `Summarizer` classes (logic extracted into pure functions)
- MCP server entrypoint, `scrub-mcp` binary, and `@modelcontextprotocol/sdk` dependency — agents should use CLI commands directly

## [0.1.1] - 2026-01-28

### Fixed

- Frontmatter now only uses YAML valid characters
- Add CHANGELOG.md

## [0.1.0] - Initial Release

### Added

- CLI tool for turning videos into Agent Skills
- ~~MCP server support~~ (removed in 0.2.0)
- YouTube transcript extraction
- Playlist support with Ink rendering
- Artifact storage system
- Skill generation with Claude
- Cached transcript support
- Deepgram and OpenAI Whisper integration
- Normalized paths to proper git format
- Removed unnecessary ./ prefix from paths
- Single JSON object expected in responses
