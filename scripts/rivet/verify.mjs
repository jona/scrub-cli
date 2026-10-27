import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "rivetkit/client";

const terminal = (status) =>
  ["completed", "completed_with_errors", "failed", "cancelled"].includes(
    status
  );
const wait = (duration) => new Promise((done) => setTimeout(done, duration));

/** Exercise current job actors. Dependencies are injectable; importing this file does no work. */
export async function verifyRivetDeployment(configuration, dependencies = {}) {
  const { endpoint, token, publicUrl, videoUrl } = configuration;
  const key = configuration.key ?? `deploy-smoke-${randomUUID()}`;
  if (!endpoint || !token || !publicUrl)
    throw new Error("Set RIVET_ENDPOINT, RIVET_TOKEN, and RIVET_PUBLIC_URL");
  if (new URL(endpoint).hostname === new URL(publicUrl).hostname)
    throw new Error("The engine endpoint and public app URL must be separate");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(key))
    throw new Error("Use an opaque verification key of at most 200 characters");
  const request = dependencies.fetch ?? globalThis.fetch;
  const create = dependencies.createClient ?? createClient;
  const sleep = dependencies.sleep ?? wait;
  const now = dependencies.now ?? Date.now;
  const health = await request(new URL("/healthz", publicUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(health.status, 200, "Public app must answer HTTP 200");
  const info = await health.json();
  assert.equal(info.service, "scrub");
  assert.equal(info.status, "ok");
  const unauthenticated = await request(new URL(`/jobs/${key}`, publicUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    unauthenticated.status,
    401,
    "Job routes must require authentication"
  );
  await unauthenticated.body?.cancel();

  const client = create({ endpoint, token });
  let actor;
  let submitted = false;
  let finished = false;
  try {
    actor = client.scrubRequest.getOrCreate([key]);
    const before = await actor.getStatus();
    await assert.rejects(
      actor.start({
        url: "https://example.invalid/not-a-youtube-source",
        settings: { inference: { mode: "preprocess" } },
      })
    );
    assert.deepEqual(
      await actor.getStatus(),
      before,
      "Rejected input must not change durable request state"
    );
    const isolated = await client.scrubRequest
      .getOrCreate([`${key}-isolation`])
      .getStatus();
    assert.equal(
      isolated,
      null,
      "A fresh request actor must have isolated state"
    );
    const report = {
      publicHttp: "passed",
      authentication: "passed",
      actor: "scrubRequest",
      key,
      actions: ["getStatus", "start(invalid)"],
      invalidInputPreservesState: "passed",
      actorIsolation: "passed",
      pipeline: "unverified",
    };
    if (!videoUrl) return report;

    const accepted = await actor.start({
      url: videoUrl,
      maxVideos: 1,
      concurrency: 1,
      settings: {
        skipVisuals: true,
        inference: { mode: "preprocess" },
        limits: { maxDurationSeconds: 120 },
      },
    });
    submitted = true;
    assert.equal(accepted.id, key);
    let status = accepted;
    const deadline = now() + 5 * 60_000;
    while (!terminal(status.status) && now() < deadline) {
      await sleep(2_000);
      status = await actor.getStatus();
      assert.ok(status, "Submitted request state must remain available");
    }
    assert.equal(
      status.status,
      "completed",
      "Optional preprocessing verification must finish successfully"
    );
    finished = true;
    const results = await actor.getResults(0, 1);
    const item = results.items[0];
    assert.ok(
      item?.result,
      "Completed request must expose artifact references"
    );
    assert.equal(item.result.mode, "preprocess");
    const readArtifact = async (ref) => {
      assert.ok(
        ref &&
          Number.isSafeInteger(ref.size) &&
          ref.size > 0 &&
          ref.size <= 2 * 1024 * 1024,
        "Verification artifacts must have bounded declared sizes"
      );
      const parts = [];
      for (let offset = 0; offset < ref.size; ) {
        const length = Math.min(128 * 1024, ref.size - offset);
        const chunk = await client.scrubVideo
          .get([key, item.videoId])
          .readArtifact(ref.id, offset, length);
        const bytes = Buffer.from(chunk.data, "base64");
        assert.equal(chunk.size, ref.size, "Artifact size must remain stable");
        assert.ok(
          bytes.byteLength > 0 && bytes.byteLength <= length,
          "Artifact reads must advance within the requested bound"
        );
        parts.push(bytes);
        offset += bytes.byteLength;
      }
      return Buffer.concat(parts).toString("utf8");
    };
    const transcript = JSON.parse(await readArtifact(item.result.transcript));
    assert.ok(
      typeof transcript.fullText === "string" && transcript.fullText.trim()
    );
    const prompt = await readArtifact(item.result.prompt);
    assert.ok(
      prompt.includes(transcript.fullText.trim().slice(0, 30)),
      "Prompt must contain the generated transcript"
    );
    const schema = JSON.parse(await readArtifact(item.result.schema));
    assert.equal(schema.title, "ScrubSummary");
    return {
      ...report,
      pipeline: "passed",
      mode: "preprocess",
      jobId: accepted.id,
      pipelineArtifacts: "passed",
      videoId: item.videoId,
      transcriptCharacters: transcript.fullText.length,
    };
  } finally {
    if (submitted && !finished) {
      try {
        const status = await actor.getStatus();
        if (status && !terminal(status.status)) await actor.cancel();
      } catch {
        /* A failed verification cannot guarantee cancellation during an outage. */
      }
    }
    await client.dispose();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await verifyRivetDeployment({
      endpoint: process.env.RIVET_ENDPOINT,
      token: process.env.RIVET_TOKEN,
      publicUrl: process.env.RIVET_PUBLIC_URL,
      videoUrl: process.env.RIVET_VERIFY_VIDEO_URL,
      key: process.env.RIVET_VERIFY_KEY,
    });
    console.log(JSON.stringify(report));
  } catch {
    // SDK exceptions may contain transport headers or provider details.
    console.error(
      "Rivet deployment verification failed; check server-only configuration, app health, and actor access"
    );
    process.exitCode = 1;
  }
}
