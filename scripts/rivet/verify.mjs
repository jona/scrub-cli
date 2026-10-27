import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "rivetkit/client";

const { RIVET_ENDPOINT, RIVET_TOKEN, RIVET_PUBLIC_URL } = process.env;
if (!RIVET_ENDPOINT || !RIVET_TOKEN || !RIVET_PUBLIC_URL) {
  throw new Error(
    "Set RIVET_ENDPOINT, RIVET_TOKEN, and RIVET_PUBLIC_URL in .env.rivet.local"
  );
}
if (new URL(RIVET_ENDPOINT).hostname === new URL(RIVET_PUBLIC_URL).hostname) {
  throw new Error(
    "RIVET_ENDPOINT must be the engine URL, separate from the app URL"
  );
}

const health = await fetch(new URL("/healthz", RIVET_PUBLIC_URL), {
  signal: AbortSignal.timeout(30_000),
});
assert.equal(health.status, 200, "Public app must answer HTTP 200");
const info = await health.json();
assert.equal(info.service, "scrub");
assert.equal(info.status, "ok");

const client = createClient({
  endpoint: process.env.RIVET_ENDPOINT,
  token: process.env.RIVET_TOKEN,
});
const key = process.env.RIVET_VERIFY_KEY ?? `deploy-smoke-${randomUUID()}`;
const content = "Rivet keeps Scrub knowledge artifacts in a stateful actor.";
const metadata = { title: "Scrub deployment verification" };
const summary = {
  tldr: "Scrub runs on Rivet.",
  overview: "The prompt and render actions are available through the engine.",
  thesisAndClaims: { thesis: "Artifacts persist in actors", keyClaims: [] },
  actionableInsights: [],
  concepts: [],
  mentalModels: [],
  structureMap: [],
  openQuestions: [],
  notableQuotes: [],
  biasAnalysis: { perspective: "", possibleBiases: [], blindSpots: [] },
  knowledgeGraph: {
    topics: [],
    people: [],
    tools: [],
    technologies: [],
    relationships: [],
  },
  difficulty: { level: "beginner", prerequisites: [], targetAudience: "" },
  reusabilityPrompts: {},
  confidence: { level: "high", reasoning: "Verified by the deployment script" },
  sections: [],
  keyTakeaways: [],
  codeSnippets: [],
  references: [],
};

try {
  const actor = client.scrub.getOrCreate([key]);
  await actor.buildPrompt({ metadata, content });
  const storedPrompt = await actor.getArtifacts();
  assert.equal(storedPrompt.revision, 1);
  assert.ok(storedPrompt.prompt.prompt.includes(content));
  assert.equal(storedPrompt.prompt.schema.title, "ScrubSummary");

  await assert.rejects(actor.buildPrompt({ metadata, content: "" }));
  assert.equal((await actor.getArtifacts()).revision, 1);

  await actor.renderSummary({ metadata, summary });
  const stored = await actor.getArtifacts();
  assert.equal(stored.revision, 2);
  assert.ok(
    stored.rendered.markdown.includes("# Scrub deployment verification")
  );
  assert.ok(stored.rendered.markdown.includes(summary.tldr));
  assert.ok(stored.prompt.prompt.includes(content));

  const isolated = await client.scrub
    .getOrCreate([`${key}-isolation`])
    .getArtifacts();
  assert.equal(isolated.revision, 0);
  assert.equal(isolated.prompt, null);
  assert.equal(isolated.rendered, null);
  console.log(
    JSON.stringify({
      publicHttp: "passed",
      actor: "scrub",
      key,
      actions: ["buildPrompt", "renderSummary", "getArtifacts"],
      revision: stored.revision,
      invalidInputPreservesState: "passed",
      actorIsolation: "passed",
    })
  );
  if (process.env.RIVET_VERIFY_VIDEO_URL) {
    const job = client.scrubRequest.getOrCreate([`${key}-pipeline`]);
    const accepted = await job.start({
      url: process.env.RIVET_VERIFY_VIDEO_URL,
      maxVideos: 1,
      concurrency: 1,
      settings: { limits: { maxDurationSeconds: 120 } },
    });
    console.log(JSON.stringify({ pipeline: "accepted", jobId: accepted.id }));
    const deadline = Date.now() + 5 * 60_000;
    let status = accepted;
    while (
      !["completed", "completed_with_errors", "failed", "cancelled"].includes(
        status.status
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      status = await job.getStatus();
    }
    const results = await job.getResults(0, 1);
    const item = results.items[0];
    console.log(
      JSON.stringify({
        pipeline: status.status,
        jobId: accepted.id,
        completed: status.completed,
        failed: status.failed,
        videoId: item?.videoId,
        stage: item?.stage,
        failureCode: item?.failure?.code ?? status.failure?.code,
      })
    );
    assert.equal(
      status.status,
      "completed",
      "Live video pipeline must finish successfully"
    );
    assert.ok(
      item?.result,
      "Completed job must expose its artifact references"
    );
    const transcript = await client.scrubVideo
      .get([accepted.id, item.videoId])
      .readArtifact(item.result.transcript.id, 0, 128 * 1024);
    const parsed = JSON.parse(
      Buffer.from(transcript.data, "base64").toString("utf8")
    );
    assert.equal(typeof parsed.fullText, "string");
    assert.ok(item.result.prompt.id);
    console.log(
      JSON.stringify({
        pipelineArtifacts: "passed",
        transcriptCharacters: parsed.fullText.length,
        frames: item.result.frames.length,
      })
    );
  }
} finally {
  await client.dispose();
}
