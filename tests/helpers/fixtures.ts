import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { FIXTURES_DIR, TEST_VIDEO_ID, TEST_PLAYLIST_ID } from "../e2e/setup.js";

/**
 * Get the path to a video fixture directory
 */
export function getVideoFixturePath(videoId: string): string {
  return join(FIXTURES_DIR, "videos", videoId);
}

/**
 * Get the path to a playlist fixture directory
 */
export function getPlaylistFixturePath(playlistId: string): string {
  return join(FIXTURES_DIR, "playlists", playlistId);
}

/**
 * Check if video fixtures exist for the given video ID
 */
export function hasVideoFixtures(videoId: string): boolean {
  const fixturePath = getVideoFixturePath(videoId);
  return (
    existsSync(join(fixturePath, "metadata.json")) &&
    existsSync(join(fixturePath, "output"))
  );
}

/**
 * Check if playlist fixtures exist for the given playlist ID
 */
export function hasPlaylistFixtures(playlistId: string): boolean {
  const fixturePath = getPlaylistFixturePath(playlistId);
  return existsSync(join(fixturePath, "playlist-info.json"));
}

/**
 * Load JSON fixture file
 */
export function loadFixture<T>(relativePath: string): T {
  const fullPath = join(FIXTURES_DIR, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

/**
 * Save fixture data
 */
export function saveFixture<T>(relativePath: string, data: T): void {
  const fullPath = join(FIXTURES_DIR, relativePath);
  const dir = join(fullPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, JSON.stringify(data, null, 2));
}

/**
 * Get the default test video ID
 */
export function getTestVideoId(): string {
  return TEST_VIDEO_ID;
}

/**
 * Get the default test playlist ID
 */
export function getTestPlaylistId(): string {
  return TEST_PLAYLIST_ID;
}

/**
 * Check if we're in record mode (fixtures don't exist yet)
 */
export function isRecordMode(): boolean {
  return !hasVideoFixtures(TEST_VIDEO_ID);
}
