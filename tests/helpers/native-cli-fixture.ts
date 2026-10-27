import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

export const FIRST_VIDEO = "dQw4w9WgXcQ";
export const SECOND_VIDEO = "aaaaaaaaaaa";
export const UNAVAILABLE_VIDEO = "bbbbbbbbbbb";
export const PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PL_fixture123";
const cli = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/deployments/local/cli.ts"
);
const tsx = import.meta.resolve("tsx");
export interface ToolCall {
  tool: string;
  args: string[];
}

/** Run the real local CLI with isolated settings and executable media fixtures. */
export async function createNativeCliFixture() {
  const root = await mkdtemp(join(tmpdir(), "scrub-cli-integration-"));
  const home = join(root, "home");
  const bin = join(root, "fake tools");
  const output = join(root, "output with spaces");
  const cache = join(root, "cache with spaces");
  const log = join(root, "tools.jsonl");
  const playlistFile = join(root, "playlist.json");
  const models = join(root, "models");
  await Promise.all([
    mkdir(join(home, ".scrub"), { recursive: true }),
    mkdir(bin),
    mkdir(models),
  ]);
  await writeFile(join(models, "ggml-base.bin"), "fixture model");
  await writeFile(playlistFile, JSON.stringify([FIRST_VIDEO, SECOND_VIDEO]));
  const prelude = `const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const tool=path.basename(process.argv[1]);
    fs.appendFileSync(process.env.SCRUB_FIXTURE_LOG,JSON.stringify({tool,args})+'\\n');
    const option=name=>args[args.indexOf(name)+1];\n`;
  async function executable(name: string, source: string) {
    const target = join(bin, name);
    await writeFile(target, `#!${process.execPath}\n${prelude}${source}\n`, {
      mode: 0o700,
    });
    return target;
  }
  await executable(
    "yt-dlp",
    `
    const url=new URL(args.at(-1));
    if(args.includes('--flat-playlist')){
      const ids=JSON.parse(fs.readFileSync(process.env.SCRUB_FIXTURE_PLAYLIST,'utf8'));
      const start=Number(option('--playlist-start'))||1;const end=Number(option('--playlist-end'))||ids.length;
      process.stdout.write(JSON.stringify({id:'PL_fixture123',title:'Fixture playlist',channel:'Fixture Channel',playlist_count:ids.length,
        entries:ids.slice(start-1,end).map((id,index)=>({id,title:id==='${FIRST_VIDEO}'?'First Video':id==='${SECOND_VIDEO}'?'Second Video':'Unavailable Video',duration:30,playlist_index:start+index}))}));
    }else{
      const id=url.searchParams.get('v');
      if(id==='${UNAVAILABLE_VIDEO}'){process.stderr.write('Fixture video unavailable');process.exit(1);}
      if(args.includes('--print'))process.stdout.write(JSON.stringify({title:id==='${FIRST_VIDEO}'?'First Video':'Second Video',description:'Fixture description',duration:30,thumbnail:'',channel:'Fixture Channel',upload_date:'20260101'}));
      else fs.writeFileSync(option('-o'),(args.includes('-x')?'fixture audio ':'fixture video ')+id);
    }
  `
  );
  await executable("ffprobe", "process.stdout.write('30');");
  await executable(
    "ffmpeg",
    `
    if(args.includes('-filter:v'))process.stderr.write('[showinfo] pts_time:5\\n[showinfo] pts_time:12\\n');
    else fs.writeFileSync(args.at(-1),args.includes('-vframes')?'fixture PNG bytes':'RIFF '+fs.readFileSync(option('-i'),'utf8'));
  `
  );
  const whisper = await executable(
    "whisper",
    `
    const text='Transcript '+fs.readFileSync(option('-f'),'utf8');
    fs.writeFileSync(option('-of')+'.json',JSON.stringify({result:{language:'en'},transcription:[{offsets:{from:0,to:5000},text}]}));
  `
  );
  for (const name of [
    "python",
    "python3",
    "python3.9",
    "python3.10",
    "python3.11",
    "python3.12",
  ])
    await executable(name, "process.exit(1);");
  const configuration = {
    transcription: {
      priority: ["local-whisper"],
      whisperModel: "base",
      language: "en",
    },
    output: { directory: output, includeFullTranscript: false },
    cache: { directory: cache },
    visual: { enabled: true, sceneThreshold: 0.4, maxFrames: 2 },
    localWhisper: { binaryPath: whisper, modelsPath: models },
    apis: {},
  };
  async function saveConfiguration() {
    await writeFile(
      join(home, ".scrub/config.json"),
      JSON.stringify(configuration)
    );
  }
  await saveConfiguration();
  return {
    root,
    home,
    output,
    cache,
    async run(args: string[], timeout = 12_000, entry = cli) {
      try {
        const result = await execa(
          process.execPath,
          ["--import", tsx, entry, ...args],
          {
            cwd: root,
            extendEnv: false,
            stdin: "ignore",
            reject: false,
            timeout,
            env: {
              HOME: home,
              PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
              TMPDIR: root,
              NO_COLOR: "1",
              CI: "1",
              TERM: "dumb",
              SCRUB_FIXTURE_LOG: log,
              SCRUB_FIXTURE_PLAYLIST: playlistFile,
              TSX_TSCONFIG_PATH: resolve(
                dirname(cli),
                "../../../tsconfig.json"
              ),
            },
          }
        );
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
      } catch (error) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          timedOut?: boolean;
          exitCode?: number;
        };
        return {
          exitCode: failure.exitCode ?? -1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? String(error),
          timedOut: failure.timedOut ?? false,
        };
      }
    },
    async file(name: string, content = "fixture local media") {
      const target = join(root, name);
      await writeFile(target, content);
      return target;
    },
    async playlist(ids: string[]) {
      await writeFile(playlistFile, JSON.stringify(ids));
    },
    async calls(): Promise<ToolCall[]> {
      try {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async includeTranscript(value: boolean) {
      configuration.output.includeFullTranscript = value;
      await saveConfiguration();
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function readJson<T = Record<string, unknown>>(
  path: string
): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}
