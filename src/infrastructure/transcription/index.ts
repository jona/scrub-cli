// Types and interface
export type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
  TranscriptionSource,
} from "./ITranscriber.js";

// Adapters
export { LocalWhisperAdapter } from "./adapters/LocalWhisperAdapter.js";
export { FasterWhisperAdapter } from "./adapters/FasterWhisperAdapter.js";
export { OpenAIWhisperAdapter } from "./adapters/OpenAIWhisperAdapter.js";
export { DeepgramAdapter } from "./adapters/DeepgramAdapter.js";
export { YouTubeCaptionsAdapter } from "./adapters/YouTubeCaptionsAdapter.js";

// Factory
export {
  TranscriberFactory,
  transcriberFactory,
} from "./TranscriberFactory.js";
