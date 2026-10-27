import { useState, useEffect, useRef } from "react";
import { Box, Text, Newline, useApp, useInput, useStdin } from "ink";
import { PlaylistProgress } from "./PlaylistProgress.js";
import type { CliDependencies } from "../dependencies.js";
type YouTubePlaylistOptions = Parameters<
  CliDependencies["processYouTubePlaylist"]
>[1];
import type {
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
  PlaylistProcessResult,
} from "../../../types/index.js";

interface AppProps {
  url: string;
  options: Omit<NonNullable<YouTubePlaylistOptions>, "onStart" | "onProgress">;
  processPlaylist: CliDependencies["processYouTubePlaylist"];
  onComplete?: (result: PlaylistProcessResult) => void;
  onError?: (error: Error) => void;
}

type AppState = "loading" | "processing" | "completed" | "error";

export function App({
  url,
  options,
  processPlaylist,
  onComplete,
  onError,
}: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const cancellation = useRef<AbortController | null>(null);
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") cancellation.current?.abort();
    },
    { isActive: isRawModeSupported === true }
  );
  const [state, setState] = useState<AppState>("loading");
  const [videos, setVideos] = useState<PlaylistVideoStatus[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState<PlaylistProcessResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    cancellation.current = controller;
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let active = true;
    async function run() {
      try {
        const processResult = await processPlaylist(url, {
          ...options,
          signal,
          onStart: (initialVideos, count) => {
            if (!active) return;
            setVideos(initialVideos);
            setTotal(count);
            setState("processing");
          },
          onProgress: (
            contentId: string,
            status: PlaylistVideoStatusType,
            stage?: string
          ) => {
            if (!active) return;
            setVideos((prev) =>
              prev.map((v) =>
                v.contentId === contentId ? { ...v, status, stage } : v
              )
            );
          },
        });

        if (!active) return;
        setResult(processResult);
        setState("completed");
        onComplete?.(processResult);
      } catch (err) {
        if (!active) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setState("error");
        onError?.(error);
      }
    }

    void run();
    return () => {
      active = false;
      controller.abort();
      if (cancellation.current === controller) cancellation.current = null;
    };
  }, [url, options, processPlaylist, onComplete, onError]);

  useEffect(() => {
    if (state === "completed" || state === "error") exit();
  }, [state, exit]);

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
      <Text dimColor>
        {"  "}Turn audio & video into knowledge bases for AI agents
      </Text>
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
