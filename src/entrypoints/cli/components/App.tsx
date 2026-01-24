import { useState, useEffect } from "react";
import { Box, Text, Newline } from "ink";
import { PlaylistProgress } from "./PlaylistProgress.js";
import {
  playlistProcessor,
  PlaylistProcessOptions,
} from "../../../core/PlaylistProcessor.js";
import type {
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
  PlaylistProcessResult,
} from "../../../types/index.js";

interface AppProps {
  url: string;
  options: Omit<PlaylistProcessOptions, "onStart" | "onProgress">;
  onComplete?: (result: PlaylistProcessResult) => void;
  onError?: (error: Error) => void;
}

type AppState = "loading" | "processing" | "completed" | "error";

/**
 * Main Ink application for CLI
 * Manages state and renders progress
 */
export function App({ url, options, onComplete, onError }: AppProps) {
  const [state, setState] = useState<AppState>("loading");
  const [videos, setVideos] = useState<PlaylistVideoStatus[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState<PlaylistProcessResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function run() {
      try {
        const processResult = await playlistProcessor.processPlaylist(url, {
          ...options,
          onStart: (initialVideos, count) => {
            setVideos(initialVideos);
            setTotal(count);
            setState("processing");
          },
          onProgress: (
            videoId: string,
            status: PlaylistVideoStatusType,
            stage?: string
          ) => {
            setVideos((prev) =>
              prev.map((v) =>
                v.videoId === videoId ? { ...v, status, stage } : v
              )
            );
          },
        });

        setResult(processResult);
        setState("completed");
        onComplete?.(processResult);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setState("error");
        onError?.(error);
      }
    }

    run();
  }, [url, options, onComplete, onError]);

  return (
    <Box flexDirection="column">
      <Header />
      <Newline />
      <PlaylistProgress videos={videos} total={total} />
      {state === "completed" && result && <CompletionSummary result={result} />}
      {state === "error" && error && <ErrorDisplay error={error} />}
    </Box>
  );
}

function Header() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {"  "}Scrub
      </Text>
      <Text dimColor>{"  "}Turn videos into knowledge bases for AI agents</Text>
    </Box>
  );
}

function CompletionSummary({ result }: { result: PlaylistProcessResult }) {
  const { playlist, succeeded, failed, skipped, stats } = result;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="green">{"\u2713"} Processing complete!</Text>
      <Newline />
      <Text bold color="cyan">
        Results
      </Text>
      <Text dimColor>{"─".repeat(20)}</Text>
      <KeyValue label="Playlist" value={playlist.title} />
      <KeyValue label="Total videos" value={String(playlist.videoCount)} />
      <KeyValue label="Succeeded" value={String(succeeded)} />
      {failed > 0 && (
        <KeyValue label="Failed" value={String(failed)} color="red" />
      )}
      {skipped > 0 && (
        <KeyValue label="Skipped" value={String(skipped)} color="yellow" />
      )}
      <KeyValue label="Total time" value={formatDuration(stats.totalTime)} />
    </Box>
  );
}

function ErrorDisplay({ error }: { error: Error }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red">{"\u2717"} Processing failed</Text>
      <Text color="red">{error.message}</Text>
    </Box>
  );
}

function KeyValue({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <Box>
      <Text dimColor>
        {"  "}
        {label}:{" "}
      </Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
