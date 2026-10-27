import { PipelineError } from "./errors.js";

export interface YouTubeVideoSource {
  kind: "video";
  videoId: string;
  url: string;
}

export interface YouTubePlaylistSource {
  kind: "playlist";
  playlistId: string;
  videoId?: string;
  url: string;
}

export type YouTubeSource = YouTubeVideoSource | YouTubePlaylistSource;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,200}$/;
const VIDEO_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const EMBED_HOSTS = new Set([
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

function invalidSource(): never {
  throw new PipelineError(
    "invalid_source",
    "Expected a valid YouTube video ID or YouTube video/playlist URL",
    { stage: "source" }
  );
}

/** Validate identity and discard tracking parameters before any external operation. */
export function parseYouTubeSource(input: string): YouTubeSource {
  if (typeof input !== "string" || input.length > 4096) return invalidSource();
  const value = input.trim();
  if (VIDEO_ID.test(value)) {
    return {
      kind: "video",
      videoId: value,
      url: `https://www.youtube.com/watch?v=${value}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidSource();
  }
  if (
    !new Set(["https:", "http:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    return invalidSource();
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (
    parsed.searchParams.getAll("v").length > 1 ||
    parsed.searchParams.getAll("list").length > 1
  )
    return invalidSource();

  let videoId: string | null = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = path.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
    if (!videoId) return invalidSource();
  } else if (VIDEO_HOSTS.has(host)) {
    if (path === "/watch") videoId = parsed.searchParams.get("v");
    else if (path !== "/playlist")
      videoId =
        path.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ??
        null;
    if (path !== "/playlist" && !videoId) return invalidSource();
  } else if (EMBED_HOSTS.has(host)) {
    videoId = path.match(/^\/embed\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
    if (!videoId) return invalidSource();
  } else return invalidSource();

  if (videoId !== null && !VIDEO_ID.test(videoId)) return invalidSource();
  const playlistId = parsed.searchParams.get("list");
  if (playlistId !== null) {
    if (!PLAYLIST_ID.test(playlistId)) return invalidSource();
    return {
      kind: "playlist",
      playlistId,
      ...(videoId === null ? {} : { videoId }),
      url: `https://www.youtube.com/playlist?list=${playlistId}`,
    };
  }
  if (!videoId) return invalidSource();
  return {
    kind: "video",
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function canonicalizeYouTubeVideo(input: string): string {
  const source = parseYouTubeSource(input);
  if (!source.videoId) return invalidSource();
  return `https://www.youtube.com/watch?v=${source.videoId}`;
}

export function extractVideoId(input: string): string | null {
  try {
    return parseYouTubeSource(input).videoId ?? null;
  } catch {
    return null;
  }
}

export function extractPlaylistId(input: string): string | null {
  try {
    const source = parseYouTubeSource(input);
    return source.kind === "playlist" ? source.playlistId : null;
  } catch {
    return null;
  }
}
