import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  download,
  fetchYouTubeMetadata,
} from "../../src/infrastructure/node/download.js";

const roots: string[] = [];
const url = "https://youtu.be/dQw4w9WgXcQ";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "scrub-downloader-"));
  roots.push(root);
  const binary = join(root, "fake yt-dlp");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);\n${source}`,
    { mode: 0o700 }
  );
  return { root, runtime: { stagingRoot: root, ytdlpPath: binary } };
}

describe("bounded native downloader", () => {
  it("requests compact metadata instead of collecting large format and caption tables", async () => {
    const f = await fixture(`
      const info={title:'A "quoted" title',description:'First line\\nSecond line',duration:42,thumbnail:'',channel:'Fixture channel',upload_date:'20261027',formats:[{unused:'x'.repeat(2*1024*1024)}],automatic_captions:{unused:'y'.repeat(2*1024*1024)}};
      const template=args[args.indexOf('--print')+1];
      const projection=args.includes('--print')&&/^%\\(\\.\\{([^}]+)\\}\\)j$/.exec(template);
      const selected=projection?Object.fromEntries(projection[1].split(',').map(field=>[field,info[field]])):info;
      process.stdout.write(JSON.stringify(selected));
    `);
    const metadata = await fetchYouTubeMetadata(url, { runtime: f.runtime });
    expect(metadata).toEqual({
      contentId: "dQw4w9WgXcQ",
      title: 'A "quoted" title',
      description: "First line\nSecond line",
      duration: 42,
      thumbnailUrl: "",
      source: "Fixture channel",
      uploadDate: "2026-10-27",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("retains the one-MiB bound when projected metadata itself is oversized", async () => {
    const f = await fixture(
      "process.stdout.write(JSON.stringify({title:'oversized',duration:1,description:'x'.repeat(2*1024*1024)}));"
    );
    await expect(
      fetchYouTubeMetadata(url, { runtime: f.runtime })
    ).rejects.toMatchObject({
      code: "resource_limit",
      message: "Native stdout exceeds the configured limit",
    });
  });

  it("keeps compact metadata complete when the downloader writes excessive stderr progress", async () => {
    const f = await fixture(`
      process.stderr.write('progress '.repeat(256*1024));
      process.stdout.write(JSON.stringify({title:'complete metadata',duration:2}));
    `);
    expect(
      await fetchYouTubeMetadata(url, {
        runtime: f.runtime,
        maxDiagnosticBytes: 32,
      })
    ).toMatchObject({
      title: "complete metadata",
      duration: 2,
    });
  });

  it("completes media downloads even when a tool ignores progress suppression", async () => {
    const f = await fixture(`
      if(!args.includes('--no-progress'))throw new Error('missing progress suppression');
      process.stdout.write('progress '.repeat(256*1024));
      process.stderr.write('progress '.repeat(256*1024));
      fs.writeFileSync(args[args.indexOf('-o')+1],args.includes('-x')?'audio bytes':'video bytes');
    `);
    const metadata = {
      contentId: "dQw4w9WgXcQ",
      title: "Fixture",
      description: "",
      duration: 1,
      thumbnailUrl: "",
      source: "Fixture",
      uploadDate: "",
      url,
    };
    const result = await download(url, {
      outputDir: f.root,
      metadata,
      runtime: f.runtime,
      maxOutputBytes: 128,
    });
    expect(await readFile(result.audioPath, "utf8")).toBe("audio bytes");
    expect(await readFile(result.videoPath, "utf8")).toBe("video bytes");
  });
});
