import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it.each(["preprocess", "full"] as const)(
  "bundles the public API for a worker and executes its %s pipeline without Node globals or polyfills",
  async (mode) => {
    const bundled = await build({
      absWorkingDir: project,
      stdin: {
        resolveDir: project,
        loader: "ts",
        contents: `
        import { runVideoPipeline, resolveSettings, createPromptArtifact, parseSummaryResponse } from "./src/index.ts";
        globalThis.probe = (async () => {
          if ("process" in globalThis || "require" in globalThis || "Buffer" in globalThis) {
            throw new Error("Unexpected Node capability");
          }
          const objects = new Map();
          let sequence = 0;
          let run = null;
          const artifacts = {
            async put(kind, data, mediaType) {
              const chunks = []; let size = 0;
              for await (const chunk of data instanceof Uint8Array ? [data] : data) {
                chunks.push(chunk); size += chunk.byteLength;
              }
              const bytes = new Uint8Array(size); let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
              const id = "worker-" + ++sequence;
              objects.set(id, bytes);
              return { id, kind, mediaType, size };
            },
            async *read(ref) { yield objects.get(ref.id); },
            async has(ref) { return objects.has(ref.id); },
            async readRange(ref, offset, length) { return objects.get(ref.id).slice(offset, offset + length); },
          };
          const metadata = { contentId: "dQw4w9WgXcQ", title: "Worker media", description: "", duration: 5,
            thumbnailUrl: "", source: "Fixture", uploadDate: "2026-01-01", url: "https://youtu.be/dQw4w9WgXcQ" };
          const full = ${mode === "full"};
          const settings = resolveSettings(full ? {
            inference: {mode:"full",summary:{provider:"worker-model",model:"summary"},vision:{provider:"worker-model",model:"vision"},includeFullTranscript:true}
          } : { skipVisuals: true });
          const modelCalls = [];
          const models = {
            supports(selection) { return selection.provider === "worker-model" && ["summary", "vision"].includes(selection.model); },
            async generate(request) {
              if ("process" in globalThis || "require" in globalThis || "Buffer" in globalThis) throw new Error("Model adapter gained Node capabilities");
              modelCalls.push(request.schemaName);
              if (request.schemaName === "ScrubFrameAnalysis") {
                if (request.images?.length !== 1 || request.images[0].data[0] !== 137) throw new Error("Missing published image input");
                return {value:{description:"A portable worker diagram",extractedText:"queue.add(task)",visualType:"diagram"},provider:request.selection.provider,model:request.selection.model,usage:{inputTokens:10,outputTokens:5}};
              }
              if (request.schemaName !== "ScrubSummary" || !request.prompt.includes("queue.add(task)")) throw new Error("Vision evidence did not reach summary generation");
              return {provider:request.selection.provider,model:request.selection.model,usage:{inputTokens:20,outputTokens:15},value:{
                tldr:"A worker queues portable tasks.",overview:"The fixture explains a portable queue.",
                thesisAndClaims:{thesis:"Inject platform capabilities",keyClaims:[{claim:"Workers need no Node runtime",evidence:"The pipeline runs in this isolate"}]},
                actionableInsights:[],concepts:[],mentalModels:[],structureMap:[],openQuestions:[],notableQuotes:[],
                biasAnalysis:{perspective:"Worker example",possibleBiases:[],blindSpots:[]},
                knowledgeGraph:{topics:["portability"],people:[],tools:[],technologies:[],relationships:[]},
                difficulty:{level:"beginner",prerequisites:[],targetAudience:"Developers"},reusabilityPrompts:{},
                confidence:{level:"high",reasoning:"Grounded in the fixture transcript and frame"},
                sections:[{title:"Queue",startTime:0,endTime:5,content:"Queue tasks through an injected capability."}],
                keyTakeaways:["Keep platform capabilities outside application logic"],codeSnippets:[],references:[]
              }};
            }
          };
          const result = await runVideoPipeline({ kind: "youtube", url: metadata.url }, settings, {
            artifacts,
            ...(full ? {models} : {}),
            runs: { async get() { return run; }, async update(change) { run = change(run); return run; } },
            media: {
              async acquire() { return { metadata, audio: await artifacts.put("source/audio", new Uint8Array([1]), "audio/wav"),
                ...(full ? {video:await artifacts.put("source/video",new Uint8Array([2]),"video/mp4")} : {}) }; },
              async extractFrames() {
                if (!full) throw new Error("Disabled frames must not run");
                return [{timestamp:2,artifact:await artifacts.put("frame",new Uint8Array([137,80,78,71]),"image/png")}];
              },
            },
            transcriber: { async transcribe() { return { segments: [{ start: 0, end: 5, text: "worker transcript" }],
              fullText: "worker transcript", language: "en", duration: 5, source: "custom-worker-provider" }; } },
          }, { runId: "worker-job", attemptId: "1", signal: new AbortController().signal,
            now: () => 1793030400000, emit() {} });
          const prompt = new TextDecoder().decode(objects.get(result.prompt.id));
          const standalone = createPromptArtifact({ metadata: { title: "Portable" }, content: "Typed input works" });
          const inference = result.inference ? {
            summary:JSON.parse(new TextDecoder().decode(objects.get(result.inference.summary.id))),
            visuals:JSON.parse(new TextDecoder().decode(objects.get(result.inference.visualAnalysis.id))),
            markdown:new TextDecoder().decode(objects.get(result.inference.markdown.id)),
            usage:JSON.parse(new TextDecoder().decode(objects.get(result.inference.modelUsage.id))),
            refs:Object.values(result.inference).every(ref=>objects.has(ref.id)),
          } : undefined;
          if (inference && parseSummaryResponse(inference.summary,metadata).title !== metadata.title) throw new Error("Invalid published structured summary");
          return { status: run.status, progress: run.progress, prompt, standalone: standalone.schema.title,
            refs: [result.audio, result.transcript, result.prompt, result.schema].every(ref => objects.has(ref.id)),
            mode:result.mode,modelCalls,inference };
        })();
      `,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(
      Object.keys(bundled.metafile!.inputs).some((path) =>
        path.includes("src/infrastructure/")
      )
    ).toBe(false);
    const worker = createContext({
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      AbortController,
      structuredClone,
    });
    new Script(bundled.outputFiles![0].text).runInContext(worker, {
      timeout: 5_000,
    });
    const result = await worker.probe;
    expect(result).toMatchObject({
      status: "completed",
      progress: 100,
      standalone: "ScrubSummary",
      refs: true,
    });
    expect(result.prompt).toContain("[0:00] worker transcript");
    expect(result.mode).toBe(mode);
    if (mode === "full") {
      expect(result.modelCalls).toEqual(["ScrubFrameAnalysis", "ScrubSummary"]);
      expect(result.inference).toMatchObject({
        refs: true,
        summary: { tldr: "A worker queues portable tasks." },
        visuals: [
          {
            timestamp: 2,
            extractedText: "queue.add(task)",
            visualType: "diagram",
          },
        ],
        usage: { calls: 2 },
      });
      expect(result.inference.summary).not.toHaveProperty("title");
      expect(result.inference.markdown).toContain("# Worker media");
      expect(result.inference.markdown).toContain(
        "A worker queues portable tasks."
      );
      expect(result.inference.markdown).toContain("## Full Transcript");
      expect(result.inference.markdown).toContain("2026-10-26T16:00:00.000Z");
    } else {
      expect(result.modelCalls).toEqual([]);
      expect(result.inference).toBeUndefined();
    }
  }
);
