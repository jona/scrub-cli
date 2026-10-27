import { build } from "esbuild";
import { Script, createContext } from "node:vm";
import { expect, it } from "vitest";

it("runs shared background coordination in a worker isolate without Node capabilities", async () => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "ts",
      contents: `
        import { RequestService } from "./src/application/jobs/RequestService.ts";
        import { RequestCoordinator } from "./src/application/jobs/RequestCoordinator.ts";
        import { SubmissionPolicy, canonicalJobValue } from "./src/application/jobs/submission.ts";
        globalThis.probe = (async () => {
          if ("process" in globalThis || "require" in globalThis || "Buffer" in globalThis) throw new Error("Unexpected Node capability");
          let request = null; const members = []; const events = [];
          const repository = {
            async get() { return structuredClone(request); },
            async update(change) { request=structuredClone(change(structuredClone(request)));return structuredClone(request); },
            async appendMember(input,maximum) {
              if(request.cancelRequested || members.length>=maximum || members.some(m=>m.videoId===input.videoId))return;
              const position=members.length+1;members.push({...input,position,status:"queued",started:false,details:{...input,position,status:"queued"}});
            },
            async members(query={}) { return structuredClone(members.filter(m=>(query.started===undefined||m.started===query.started)&&(!query.statuses||query.statuses.includes(m.status))).slice(query.offset??0,query.limit===undefined?undefined:(query.offset??0)+query.limit)); },
            async updateMember(member) { members[members.findIndex(m=>m.videoId===member.videoId)]=structuredClone(member); },
            async cancelPending() { for(const member of members) if(!member.started&&member.status==="queued")member.status="cancelled"; },
          };
          const complete={status:"completed",stage:"completed",progress:100,attempts:1};
          const videos={
            async initialize() { if(!events.includes("reconcile:poll"))throw new Error("Wake not durable before dispatch");return complete; },
            async getStatus(){return complete;},async getResult(){return null;},async cancel(){return {...complete,status:"cancelled"};},
            async retry(){return {...complete,status:"queued"};},async readArtifact(){return {bytes:new Uint8Array(),mediaType:"text/plain",size:0};},
          };
          const runtime={async scheduleReconcile(reason){events.push("reconcile:"+reason);},async wakeEnumeration(reason){events.push("enumerate:"+reason);},isEnumerationActive(){return false;},abortEnumeration(){}};
          const environment={now:()=>1800000000000,fingerprint:canonicalJobValue};
          const options={repository,videos,runtime,environment,policy:new SubmissionPolicy({requestDefault:1,inferenceDefaults:{mode:"preprocess"}})};
          const service=new RequestService(options), coordinator=new RequestCoordinator(options);
          await service.start("worker-job",{url:"https://youtube.com/playlist?list=PLfixture"});
          await coordinator.enumerate({async enumerate(){return {metadata:{title:"Fixture",description:"",channel:"",videoCount:1,url:"https://youtube.com/playlist?list=PLfixture"},entries:(async function*(){yield{id:"aaaaaaaaaaa",title:"Worker video",url:"https://youtu.be/aaaaaaaaaaa"};})()};}},
            {runId:"worker-job",attemptId:"1",signal:new AbortController().signal,now:environment.now,emit(){}});
          const completed=await coordinator.reconcile();
          return {completed,results:await service.getResults(0,10),member:await service.hasVideo("aaaaaaaaaaa"),events};
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
    Uint8Array,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    structuredClone,
  });
  new Script(bundled.outputFiles![0].text).runInContext(worker, {
    timeout: 5000,
  });
  const result = await worker.probe;
  expect(result).toMatchObject({
    completed: {
      id: "worker-job",
      status: "completed",
      total: 1,
      completed: 1,
    },
    results: {
      total: 1,
      items: [{ videoId: "aaaaaaaaaaa", status: "completed" }],
    },
    member: true,
  });
});
