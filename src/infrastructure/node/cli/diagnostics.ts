import { commandExists } from "../../../utils/helpers.js";
import { config } from "../../Config.js";
import { TranscriberFactory } from "../../transcription/TranscriberFactory.js";

/** Local discovery is a CLI concern; server adapters receive explicit settings. */
export function getTranscriberDiagnostics() {
  return new TranscriberFactory({ config }).getDiagnostics();
}

async function prerequisites(youtube: boolean) {
  const missing: string[] = [];
  if (youtube && !(await commandExists("yt-dlp")))
    missing.push("yt-dlp (required for YouTube video download)");
  if (!(await commandExists("ffmpeg")))
    missing.push("ffmpeg (required for audio/video processing)");
  const transcribers = await getTranscriberDiagnostics();
  return {
    ready: missing.length === 0,
    missing,
    warnings: transcribers.some((transcriber) => transcriber.available)
      ? []
      : ["No transcription adapters available."],
  };
}

export const checkFilePrerequisites = () => prerequisites(false);
export const checkYouTubePrerequisites = () => prerequisites(true);
export async function getDiagnostics() {
  return {
    ytdlp: await commandExists("yt-dlp"),
    ffmpeg: await commandExists("ffmpeg"),
    transcribers: await getTranscriberDiagnostics(),
  };
}
