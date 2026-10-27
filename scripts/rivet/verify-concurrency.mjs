import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "rivetkit/client";

const { RIVET_ENDPOINT: endpoint, RIVET_TOKEN: token } = process.env;
if (!endpoint || !token)
  throw new Error(
    "Set server-side Rivet credentials in ignored .env.rivet.local"
  );
const client = createClient({ endpoint, token });
const run = randomUUID();
const submitted = [];
let transientRetries = 0;
async function readWithRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const transient =
        /fetch failed|HTTP request error|connection|network|timed out/i.test(
          error.message ?? ""
        ) || [502, 503, 504].includes(error.statusCode ?? error.status);
      if (!transient || attempt >= 5) throw error;
      transientRetries++;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * (attempt + 1), 2000))
      );
    }
  }
}
const terminal = (status) =>
  ["completed", "completed_with_errors", "cancelled", "failed"].includes(
    status
  );
try {
  // Exercise the distributed semaphore without changing the deployment's cap.
  const gate = client.scrubAdmission.getOrCreate([`verify-${run}`]);
  const owners = ["one", "two", "three"].map((name) => `${run}:${name}`);
  const held = [];
  try {
    const grants = await Promise.all(
      owners.map((owner) => gate.acquire(owner, 2))
    );
    grants.forEach((lease, index) => {
      if (lease.granted)
        held.push({ owner: owners[index], token: lease.token });
    });
    assert.equal(
      held.length,
      2,
      "Concurrent global acquisition must grant exactly two slots"
    );
    const blocked = owners[grants.findIndex((lease) => !lease.granted)];
    const first = held.shift();
    await gate.release(first.owner, first.token);
    assert.equal(await gate.validate(first.owner, first.token), false);
    const next = await gate.acquire(blocked, 2);
    assert.equal(next.granted, true);
    held.push({ owner: blocked, token: next.token });
    console.log(
      JSON.stringify({
        distributedCapacity: 2,
        thirdOwnerBlocked: true,
        releasedCapacityReused: true,
      })
    );
  } finally {
    await Promise.all(
      held.map((lease) => gate.release(lease.owner, lease.token))
    );
  }

  const requests = Array.from({ length: 3 }, (_, index) =>
    client.scrubRequest.getOrCreate([`concurrency-${run}-${index}`])
  );
  submitted.push(...requests);
  const input = {
    url:
      process.env.RIVET_VERIFY_VIDEO_URL ??
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    concurrency: 2,
    settings: {
      skipVisuals: true,
      limits: { maxDurationSeconds: 120 },
      inference: { mode: "preprocess" },
    },
  };
  const accepted = await Promise.all(
    requests.map((request) => readWithRetry(() => request.start(input)))
  );
  console.log(JSON.stringify({ jobsAccepted: accepted.map((job) => job.id) }));
  const deadline = Date.now() + 5 * 60_000;
  let statuses = accepted;
  while (
    statuses.some((job) => !terminal(job.status)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    statuses = await Promise.all(
      requests.map((request) => readWithRetry(() => request.getStatus()))
    );
  }
  for (const job of statuses)
    assert.equal(job.status, "completed", `Job ${job.id} must complete`);
  const pages = await Promise.all(
    requests.map((request) => readWithRetry(() => request.getResults(0, 1)))
  );
  const intervals = pages.map((page) => {
    const item = page.items[0];
    assert.ok(item.result);
    const end = Date.parse(item.result.completedAt);
    return {
      actorId: item.actorId,
      start: end - item.result.stats.totalTime,
      end,
    };
  });
  const events = intervals
    .flatMap((interval) => [
      { at: interval.start, delta: 1 },
      { at: interval.end, delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  const expected = Number(process.env.RIVET_VERIFY_EXPECTED_CONCURRENCY ?? 2);
  assert.equal(
    peak,
    expected,
    "Persisted pipeline intervals must demonstrate the expected concurrency"
  );
  console.log(
    JSON.stringify({
      concurrentPipelines: peak,
      jobsCompleted: statuses.length,
      transientReadRetries: transientRetries,
      intervals,
    })
  );
} finally {
  await Promise.allSettled(
    submitted.map(async (request) => {
      const status = await readWithRetry(() => request.getStatus());
      if (status && !terminal(status.status))
        await readWithRetry(() => request.cancel());
    })
  );
  await client.dispose();
}
