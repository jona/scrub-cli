import { extname } from "node:path";
import {
  importLocalSource,
  runLocalPipeline,
  type LocalPipelineOptions,
  type LocalProcessResult,
} from "./pipeline.js";
export async function processFile(
  filePath: string,
  options: LocalPipelineOptions = {}
): Promise<LocalProcessResult> {
  const input = {
    ...options,
    skipVisuals:
      extname(filePath).toLowerCase() === ".mp3" || options.skipVisuals,
  };
  const source = await importLocalSource(filePath, input);
  return runLocalPipeline(source, input, filePath);
}
