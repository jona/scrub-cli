import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "rivetkit/client";
import {
  summaryInputSchema,
  visualAnalysisSchema,
} from "../../dist/core/artifacts.js";

const {
  RIVET_ENDPOINT: endpoint,
  RIVET_TOKEN: token,
  RIVET_PUBLIC_URL: origin,
} = process.env;
if (!endpoint || !token || !origin)
  throw new Error("Set the server-only Rivet verification environment");
const client = createClient({ endpoint, token });
const terminal = (status) =>
  ["completed", "completed_with_errors", "failed", "cancelled"].includes(
    status
  );
const submitted = [];
async function read(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 5 ||
        !/fetch failed|HTTP request error|connection|network|timed out/i.test(
          error.message ?? ""
        )
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * (attempt + 1), 2000))
      );
    }
  }
}
async function artifact(jobId, videoId, ref) {
  assert.ok(
    ref && Number.isSafeInteger(ref.size) && ref.size <= 2 * 1024 * 1024
  );
  const pieces = [];
  for (let offset = 0; offset < ref.size; ) {
    const response = await read(() =>
      client.scrubVideo
        .get([jobId, videoId])
        .readArtifact(ref.id, offset, Math.min(128 * 1024, ref.size - offset))
    );
    const bytes = Buffer.from(response.data, "base64");
    assert.ok(bytes.length > 0);
    pieces.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat(pieces).toString("utf8");
}
try {
  const health = await fetch(new URL("/healthz", origin), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(health.status, 200);
  const run = randomUUID();
  const selections = [
    {
      summary: {
        provider: "openai",
        model: process.env.RIVET_VERIFY_SUMMARY_MODEL ?? "gpt-6.1-sol",
      },
      vision: {
        provider: "openai",
        model: process.env.RIVET_VERIFY_VISION_MODEL ?? "gpt-6.1-terra",
      },
    },
  ];
  for (let index = 0; index < selections.length; index++) {
    const request = client.scrubRequest.getOrCreate([
      `full-model-verification-${run}-${index}`,
    ]);
    submitted.push(request);
    const accepted = await read(() =>
      request.start({
        url:
          process.env.RIVET_VERIFY_VIDEO_URL ??
          "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        maxVideos: 1,
        concurrency: 1,
        settings: {
          sceneThreshold: 0,
          maxFrames: 2,
          limits: { maxDurationSeconds: 120 },
          inference: {
            mode: "full",
            ...selections[index],
            limits: { maxModelCalls: 8 },
          },
        },
      })
    );
    console.log(
      JSON.stringify({ accepted: accepted.id, selections: selections[index] })
    );
    let status = accepted;
    const deadline = Date.now() + 10 * 60_000;
    while (!terminal(status.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      status = await read(() => request.getStatus());
    }
    const results = await read(() => request.getResults(0, 1));
    const item = results.items[0];
    console.log(
      JSON.stringify({
        jobId: accepted.id,
        status: status.status,
        stage: item?.stage,
        failureCode: item?.failure?.code ?? status.failure?.code,
      })
    );
    assert.equal(
      status.status,
      "completed",
      "Full model job must complete successfully"
    );
    const result = item.result;
    assert.equal(result.mode, "full");
    assert.ok(result.inference);
    assert.ok(result.frames.length > 0);
    const visuals = JSON.parse(
      await artifact(accepted.id, item.videoId, result.inference.visualAnalysis)
    );
    assert.equal(visuals.length, result.frames.length);
    for (const visual of visuals) visualAnalysisSchema.parse(visual);
    const summary = JSON.parse(
      await artifact(accepted.id, item.videoId, result.inference.summary)
    );
    summaryInputSchema.parse(summary);
    assert.ok(summary.tldr.trim());
    const markdown = await artifact(
      accepted.id,
      item.videoId,
      result.inference.markdown
    );
    assert.ok(markdown.startsWith(`# ${result.metadata.title}`));
    assert.ok(markdown.includes(summary.tldr));
    const usage = JSON.parse(
      await artifact(accepted.id, item.videoId, result.inference.modelUsage)
    );
    assert.ok(usage.calls >= result.frames.length + 1 && usage.calls <= 8);
    assert.ok(
      usage.steps.some(
        (step) =>
          step.name.startsWith("vision:") &&
          step.provider === selections[index].vision.provider
      )
    );
    assert.ok(
      usage.steps.some(
        (step) =>
          step.name === "summary:final" &&
          step.provider === selections[index].summary.provider
      )
    );
    console.log(
      JSON.stringify({
        fullPipeline: "passed",
        jobId: accepted.id,
        actorId: item.actorId,
        frames: visuals.length,
        summaryProvider: selections[index].summary.provider,
        visionProvider: selections[index].vision.provider,
        calls: usage.calls,
        markdownBytes: result.inference.markdown.size,
      })
    );
  }
} finally {
  await Promise.allSettled(
    submitted.map(async (request) => {
      const status = await read(() => request.getStatus());
      if (status && !terminal(status.status)) await request.cancel();
    })
  );
  await client.dispose();
}
