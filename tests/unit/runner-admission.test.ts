import { describe, expect, it } from "vitest";
import { RunnerAdmission } from "../../src/infrastructure/runtime/RunnerAdmission.js";

describe("runner-local admission", () => {
  it("shares capacity across requests on one runner, independently of other runners", () => {
    const first = new RunnerAdmission(2);
    const second = new RunnerAdmission(2);
    expect(first.tryAcquire("request-a/video-1")).not.toBeNull();
    expect(first.tryAcquire("request-b/video-2")).not.toBeNull();
    expect(first.tryAcquire("request-c/video-3")).toBeNull();
    expect(second.tryAcquire("request-c/video-3")).not.toBeNull();
    expect(first.activeCount).toBe(2);
    expect(second.activeCount).toBe(1);
  });

  it("holds capacity until release, and makes acquisition/release idempotent", () => {
    const admission = new RunnerAdmission(1);
    const original = admission.tryAcquire("owner")!;
    expect(admission.tryAcquire("owner")).toBe(original);
    expect(admission.tryAcquire("other")).toBeNull();
    original.release();
    original.release();
    expect(original.isActive()).toBe(false);
    const replacement = admission.tryAcquire("owner")!;
    expect(replacement.token).toBeGreaterThan(original.token);
    original.release();
    expect(replacement.isActive()).toBe(true);
    expect(admission.tryAcquire("other")).toBeNull();
    replacement.release();
    expect(admission.tryAcquire("other")).not.toBeNull();
  });

  it.each([0, -1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid runner capacity %s",
    (capacity) => {
      expect(() => new RunnerAdmission(capacity)).toThrow(RangeError);
    }
  );
});
