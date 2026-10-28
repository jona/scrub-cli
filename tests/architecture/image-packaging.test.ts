import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const workspaces: string[] = [];
const recipe = () => readFile(join(root, "Dockerfile"), "utf8");
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("deployment image packaging boundary", () => {
  it("selects existing local composition modules through the shared Bake recipe", async () => {
    const source = await readFile(join(root, "docker-bake.hcl"), "utf8");
    const starts = [...source.matchAll(/^target "([^"]+)"\s*\{/gm)];
    const profiles = new Map(
      starts.map((match, index) => [
        match[1],
        source.slice(match.index, starts[index + 1]?.index ?? source.length),
      ])
    );
    expect([...profiles.keys()].sort()).toEqual([
      "_native",
      "local-api",
      "local-cli",
      "local-mcp",
      "server-api",
    ]);
    expect(profiles.get("_native")).toContain('dockerfile = "Dockerfile"');
    expect(profiles.get("_native")).toContain('target = "runner"');
    expect(profiles.get("server-api")).toContain('inherits = ["local-api"]');
    for (const [name, composition] of [
      ["local-cli", "cli"],
      ["local-api", "api"],
      ["local-mcp", "mcp"],
    ]) {
      expect(profiles.get(name)).toContain('inherits = ["_native"]');
      expect(profiles.get(name)).toContain(
        `SCRUB_ENTRYPOINT = "dist/deployments/local/${composition}.js"`
      );
      await access(join(root, `src/deployments/local/${composition}.ts`));
    }
  });

  it("defaults to the CLI module and preserves literal command arguments", async () => {
    const source = await recipe();
    const entrypoint = JSON.parse(
      source.match(/^ENTRYPOINT\s+(\[.*\])$/m)![1]
    ) as string[];
    expect(source).toContain(
      "ARG SCRUB_ENTRYPOINT=dist/deployments/local/cli.js"
    );
    expect(source).toContain("ENV SCRUB_ENTRYPOINT=${SCRUB_ENTRYPOINT}");
    const workspace = await mkdtemp(join(tmpdir(), "scrub image arguments "));
    workspaces.push(workspace);
    const composition = join(workspace, "composition with spaces.cjs");
    await writeFile(
      composition,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))"
    );
    const args = [
      "youtube",
      "https://example.test/a?x=1&y=2",
      "--output-dir",
      "path with spaces",
      "$literal",
    ];
    const { stdout } = await execute(
      entrypoint[0],
      [...entrypoint.slice(1), ...args],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          SCRUB_ENTRYPOINT: composition,
        },
        timeout: 10_000,
      }
    );
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it("installs locked dependencies and carries the required media licenses", async () => {
    const source = await recipe();
    const instructions = source.replace(/\\\r?\n/g, " ").split(/\r?\n/);
    const installs = instructions.filter(
      (line) => /^RUN\s/.test(line) && /\bnpm ci\b/.test(line)
    );
    expect(installs).toHaveLength(2);
    expect(installs.some((line) => line.includes("--omit=dev"))).toBe(true);
    expect(source).toContain("--require-hashes --only-binary=:all:");
    expect(source).toContain("python -m pip check");
    expect(source).toContain("COPY LICENSE ./");
    expect(source).toContain(
      "COPY deployments/image/licenses ./third_party_licenses"
    );
    for (const file of [
      "LICENSE",
      "deployments/image/licenses/faster-whisper-LICENSE",
      "deployments/image/licenses/whisper-LICENSE",
    ]) {
      expect((await readFile(join(root, file), "utf8")).length).toBeGreaterThan(
        100
      );
    }
  });
});
