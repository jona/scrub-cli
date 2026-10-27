import { PipelineError } from "../core/errors.js";
import type { ArtifactRef, ArtifactStorage } from "./contracts.js";

export function limitArtifactStorage(
  storage: ArtifactStorage,
  maximum: number,
  sourceMaximum = maximum
): ArtifactStorage {
  const maximumFor = (kind: string) =>
    kind === "source/video" ? sourceMaximum : maximum;
  const check = (ref: ArtifactRef) => {
    const limit = maximumFor(ref.kind);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > limit)
      throw new PipelineError(
        "resource_limit",
        `Artifact exceeds ${limit} bytes`
      );
  };
  return {
    async put(kind, data, mediaType) {
      async function* bounded() {
        let size = 0;
        for await (const chunk of data instanceof Uint8Array ? [data] : data) {
          size += chunk.byteLength;
          if (size > maximumFor(kind))
            throw new PipelineError(
              "resource_limit",
              `Artifact exceeds ${maximumFor(kind)} bytes`
            );
          yield chunk;
        }
      }
      const ref = await storage.put(kind, bounded(), mediaType);
      check(ref);
      return ref;
    },
    read(ref) {
      check(ref);
      return storage.read(ref);
    },
    has(ref) {
      check(ref);
      return storage.has(ref);
    },
    readRange(ref, offset, length) {
      check(ref);
      return storage.readRange(ref, offset, length);
    },
  };
}

export async function readArtifactBytes(
  storage: ArtifactStorage,
  ref: ArtifactRef,
  maximum = 20 * 1024 * 1024
): Promise<Uint8Array> {
  if (ref.size > maximum)
    throw new PipelineError(
      "resource_limit",
      `Artifact exceeds read limit of ${maximum} bytes`
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of storage.read(ref)) {
    length += chunk.byteLength;
    if (length > maximum)
      throw new PipelineError(
        "resource_limit",
        `Artifact exceeds read limit of ${maximum} bytes`
      );
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function readArtifactJson<T>(
  storage: ArtifactStorage,
  ref: ArtifactRef,
  maximum?: number
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(await readArtifactBytes(storage, ref, maximum))
  ) as T;
}
export function putJson(
  storage: ArtifactStorage,
  kind: string,
  value: unknown
): Promise<ArtifactRef> {
  return storage.put(
    kind,
    new TextEncoder().encode(JSON.stringify(value, null, 2)),
    "application/json"
  );
}

export function resultArtifacts(
  result: import("./contracts.js").VideoResult
): ArtifactRef[] {
  return [
    result.metadataArtifact,
    result.audio,
    ...(result.video ? [result.video] : []),
    result.transcript,
    result.transcriptText,
    result.prompt,
    result.schema,
    ...(result.framesManifest ? [result.framesManifest] : []),
    ...result.frames.map((f) => f.artifact),
    ...(result.inference
      ? [
          result.inference.visualAnalysis,
          result.inference.summary,
          result.inference.markdown,
          result.inference.modelUsage,
        ]
      : []),
  ];
}
