import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { PlaylistVideoStatus } from "../../../types/index.js";

interface PlaylistProgressProps {
  videos: PlaylistVideoStatus[];
  total: number;
}

/**
 * Display progress for playlist processing
 * Shows each video on its own line with status indicator
 */
export function PlaylistProgress({ videos, total }: PlaylistProgressProps) {
  if (videos.length === 0) {
    return (
      <Box>
        <Text>
          <Spinner type="dots" />
          <Text> Extracting playlist information...</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {videos.map((video, i) => (
        <VideoStatusLine
          key={video.videoId}
          video={video}
          index={i + 1}
          total={total}
        />
      ))}
    </Box>
  );
}

interface VideoStatusLineProps {
  video: PlaylistVideoStatus;
  index: number;
  total: number;
}

function VideoStatusLine({ video, index, total }: VideoStatusLineProps) {
  const prefix = `[${index}/${total}]`;

  return (
    <Box>
      <Text dimColor>{prefix}</Text>
      <StatusIndicator status={video.status} />
      <Text>
        {video.status === "processing" && video.stage
          ? `${video.stage}: ${video.title}`
          : video.title}
      </Text>
    </Box>
  );
}

function StatusIndicator({ status }: { status: PlaylistVideoStatus["status"] }) {
  switch (status) {
    case "completed":
      return <Text color="green"> {"\u2713"} </Text>;
    case "failed":
      return <Text color="red"> {"\u2717"} </Text>;
    case "processing":
      return (
        <Text>
          {" "}
          <Spinner type="dots" />{" "}
        </Text>
      );
    case "skipped":
      return <Text color="yellow"> {"\u2192"} </Text>;
    case "pending":
    default:
      return <Text dimColor> {"\u25CB"} </Text>;
  }
}
