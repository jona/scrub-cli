import nock from "nock";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { FIXTURES_DIR } from "../e2e/setup.js";

const CASSETTES_DIR = join(FIXTURES_DIR, "cassettes");

export interface VCROptions {
  cassetteName: string;
  subdirectory?: string;
}

/**
 * VCR (Video Cassette Recorder) for HTTP request recording/playback
 * Auto-detects mode based on whether cassette file exists
 */
export class VCR {
  private cassettePath: string;
  private isRecording: boolean;

  constructor(options: VCROptions) {
    const subdir = options.subdirectory || "anthropic";
    this.cassettePath = join(
      CASSETTES_DIR,
      subdir,
      `${options.cassetteName}.json`
    );
    this.isRecording = !existsSync(this.cassettePath);
  }

  /**
   * Start recording or playback
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      // Record mode: intercept all HTTP requests
      nock.recorder.rec({
        output_objects: true,
        dont_print: true,
      });
    } else {
      // Playback mode: load cassette and set up nock
      const cassette = JSON.parse(readFileSync(this.cassettePath, "utf-8"));
      nock.define(cassette);
    }
  }

  /**
   * Stop recording/playback and save cassette if recording
   */
  async stop(): Promise<void> {
    if (this.isRecording) {
      const recordings = nock.recorder.play() as nock.Definition[];
      nock.recorder.clear();

      if (recordings.length > 0) {
        // Sanitize and save recordings
        const sanitized = this.sanitizeRecordings(recordings);
        mkdirSync(dirname(this.cassettePath), { recursive: true });
        writeFileSync(this.cassettePath, JSON.stringify(sanitized, null, 2));
      }
    }

    nock.cleanAll();
    nock.restore();
    if (!nock.isActive()) {
      nock.activate();
    }
  }

  /**
   * Remove sensitive data from recordings
   */
  private sanitizeRecordings(recordings: nock.Definition[]): nock.Definition[] {
    return recordings.map((rec) => {
      const sanitized = { ...rec };

      // Remove API keys from headers
      if (sanitized.reqheaders) {
        const headers = { ...sanitized.reqheaders };
        delete headers["x-api-key"];
        delete headers["authorization"];
        delete headers["Authorization"];
        sanitized.reqheaders = headers;
      }

      return sanitized;
    });
  }

  /**
   * Get recording status
   */
  get mode(): "record" | "playback" {
    return this.isRecording ? "record" : "playback";
  }
}

/**
 * Create VCR hooks for use in beforeEach/afterEach
 */
export function useVCR(cassetteName: string, subdirectory = "anthropic") {
  const vcr = new VCR({ cassetteName, subdirectory });

  return {
    vcr,
    beforeEach: () => vcr.start(),
    afterEach: () => vcr.stop(),
  };
}
