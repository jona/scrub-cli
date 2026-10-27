import { extname } from "node:path";
import { isFfmpegAvailable } from "../download.js";
import { getTranscriberDiagnostics } from "../transcribe.js";
import {
  importLocalSource,
  runLocalPipeline,
  type LocalPipelineOptions,
  type LocalProcessResult,
} from "./pipeline.js";
export type FileProcessOptions = LocalPipelineOptions;
export async function processFile(
  filePath: string,
  options: FileProcessOptions = {}
): Promise<LocalProcessResult> {
  const input = {
    ...options,
    skipVisuals:
      extname(filePath).toLowerCase() === ".mp3" || options.skipVisuals,
  };
  const source = await importLocalSource(filePath, input);
  return runLocalPipeline(source, input, filePath);
}
export async function checkFilePrerequisites() {
  const missing = (await isFfmpegAvailable())
    ? []
    : ["ffmpeg (required for audio/video processing)"];
  const transcribers = await getTranscriberDiagnostics();
  return {
    ready: !missing.length,
    missing,
    warnings: transcribers.some((t) => t.available)
      ? []
      : ["No transcription adapters available."],
  };
}
