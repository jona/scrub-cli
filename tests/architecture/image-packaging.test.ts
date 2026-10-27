import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = (await import(
  new URL("../../scripts/rivet/prepare-image.mjs", import.meta.url).href
)) as {
  parseRivetBakeProfile(source: string): ImageProfile;
  renderRivetDockerfile(source: string, profile: ImageProfile): string;
  prepareRivetImage(
    root: string,
    resolveProfile?: (root: string) => Promise<ImageProfile>
  ): Promise<string>;
};
interface ImageProfile {
  target: string;
  args: Record<string, string>;
}
const profile = {
  target: "runner",
  args: {
    SCRUB_ENTRYPOINT: "dist/deployments/rivet/main.js",
    SCRUB_DEPENDENCY_HOOK: "rivet/prune-dependencies.sh",
  },
};
const resolvedBake = () => ({
  target: {
    "rivet-api": {
      context: ".",
      dockerfile: "Dockerfile",
      target: "runner",
      platforms: ["linux/amd64"],
      args: { ...profile.args },
    },
  },
});
const execute = promisify(execFile);
const workspaces: string[] = [];
const rootRecipe = () => readFile(join(projectRoot, "Dockerfile"), "utf8");
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "scrub image packaging "));
  workspaces.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("deployment image packaging boundary", () => {
  it("derives CLI fallback settings from the resolved normal Bake profile", () => {
    expect(
      helper.parseRivetBakeProfile(JSON.stringify(resolvedBake()))
    ).toEqual(profile);
    for (const key of [
      "context",
      "dockerfile",
      "target",
      "platforms",
      "args",
    ] as const) {
      const changed = resolvedBake();
      delete (changed.target["rivet-api"] as Record<string, unknown>)[key];
      expect(() =>
        helper.parseRivetBakeProfile(JSON.stringify(changed))
      ).toThrow("Bake profile");
    }
    expect(() => helper.parseRivetBakeProfile("malformed")).toThrow(
      "Bake profile"
    );
    expect(() =>
      helper.parseRivetBakeProfile(
        JSON.stringify({
          target: {
            "rivet-api": {
              ...resolvedBake().target["rivet-api"],
              platforms: ["linux/arm64"],
            },
          },
        })
      )
    ).toThrow("Bake profile");
  });
  it("keeps provider package exclusions outside the generic recipe and cleanup inside each install layer", async () => {
    const source = await rootRecipe();
    const instructions = source
      .replace(/\\\r?\n/g, " ")
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    const appPackagePaths =
      instructions
        .join("\n")
        .match(/(?:^|\s)(?:\.\/|\/app\/)?node_modules\/[^\s]+/gm) ?? [];
    expect(appPackagePaths).toEqual([]);
    expect(instructions.join("\n")).not.toContain("deployments/rivet/");
    const installs = instructions.filter(
      (line) => /^RUN\s/.test(line) && /\bnpm ci\b/.test(line)
    );
    expect(installs.length).toBeGreaterThan(0);
    for (const instruction of installs) {
      expect(instruction).toMatch(
        /--mount=[^\s]*source=deployments[^\s]*readonly/
      );
      expect(instruction.indexOf("SCRUB_DEPENDENCY_HOOK")).toBeGreaterThan(
        instruction.indexOf("npm ci")
      );
    }
  });

  it("preserves parser directives and unrelated instructions while replacing each selected ARG default", async () => {
    const header = "# syntax=docker/dockerfile:1\n# escape=\\\n\n";
    const source = header + (await rootRecipe());
    const generated = helper.renderRivetDockerfile(source, profile);
    const hook = 'ARG SCRUB_DEPENDENCY_HOOK="rivet/prune-dependencies.sh"';
    const startup = 'ENV SCRUB_ENTRYPOINT="dist/deployments/rivet/main.js"\n';
    expect(generated.startsWith(header)).toBe(true);
    expect(generated.split(hook)).toHaveLength(3);
    expect(generated.endsWith(startup)).toBe(true);
    const expected = source
      .replace(/^ARG SCRUB_DEPENDENCY_HOOK$/gm, hook)
      .replace(
        /^ARG SCRUB_ENTRYPOINT=.*$/gm,
        'ARG SCRUB_ENTRYPOINT="dist/deployments/rivet/main.js"'
      );
    expect(generated).toBe(`${expected.trimEnd()}\n\n${startup}`);
  });

  it("retains every resolved public model, concurrency, and JSON budget override", async () => {
    const bake = resolvedBake();
    Object.assign(bake.target["rivet-api"].args, {
      SCRUB_RUNNER_CONCURRENCY: "9",
      SCRUB_SUMMARY_MODEL: "custom-summary-model",
      SCRUB_VISION_MODEL: "custom-vision-model",
      SCRUB_INFERENCE_LIMITS: '{"chunkCharacters":16000,"maxModelCalls":7}',
      SCRUB_MODEL_TIMEOUT_MS: "900000",
    });
    const resolved = helper.parseRivetBakeProfile(JSON.stringify(bake));
    expect(resolved.args).toEqual(bake.target["rivet-api"].args);
    const generated = helper.renderRivetDockerfile(
      await rootRecipe(),
      resolved
    );
    expect(generated).toContain('ARG SCRUB_RUNNER_CONCURRENCY="9"');
    expect(generated).toContain(
      'ARG SCRUB_SUMMARY_MODEL="custom-summary-model"'
    );
    expect(generated).toContain('ARG SCRUB_VISION_MODEL="custom-vision-model"');
    expect(generated).toContain('ARG SCRUB_MODEL_TIMEOUT_MS="900000"');
    expect(generated).toContain(
      "ENV SCRUB_MODEL_TIMEOUT_MS=${SCRUB_MODEL_TIMEOUT_MS}"
    );
    expect(generated).toContain(
      'ARG SCRUB_INFERENCE_LIMITS="{\\"chunkCharacters\\":16000,\\"maxModelCalls\\":7}"'
    );
    expect(generated).not.toContain("ARG SCRUB_RUNNER_CONCURRENCY=2");
    expect(generated).toContain(
      "ENV SCRUB_INFERENCE_LIMITS=${SCRUB_INFERENCE_LIMITS}"
    );
  });

  it("rejects secret-shaped, unresolved, and instruction-injecting profile arguments", () => {
    for (const [key, value] of [
      ["OPENAI_API_KEY", "fixture"],
      ["RIVET_TOKEN", "fixture"],
      ["SOME_SECRET", "fixture"],
      ["A_PASSWORD", "fixture"],
      ["SCRUB_SUMMARY_MODEL", "line1\nENV INJECTED=1"],
      ["SCRUB_SUMMARY_MODEL", "carriage\rreturn"],
      ["SCRUB_SUMMARY_MODEL", "null\0byte"],
      ["SCRUB_RUNNER_CONCURRENCY", null],
      ["BAD-NAME", "value"],
    ] as const) {
      const bake = resolvedBake();
      Object.assign(bake.target["rivet-api"].args, { [key]: value });
      expect(() => helper.parseRivetBakeProfile(JSON.stringify(bake))).toThrow(
        "argument"
      );
    }
  });

  it("only renders arguments declared by the shared recipe and requires the selected final stage", async () => {
    const source = await rootRecipe();
    expect(() =>
      helper.renderRivetDockerfile(source, {
        ...profile,
        args: { ...profile.args, UNDECLARED_PUBLIC_SETTING: "value" },
      })
    ).toThrow("not declared");
    expect(() =>
      helper.renderRivetDockerfile(source, { ...profile, target: "build" })
    ).toThrow("resolved rivet-api");
    expect(() =>
      helper.renderRivetDockerfile(
        `${source}\nFROM scratch AS later\n`,
        profile
      )
    ).toThrow("final root Dockerfile stage");
    expect(() =>
      helper.renderRivetDockerfile(
        `${source}\nFROM scratch AS runner\n`,
        profile
      )
    ).toThrow("Duplicate");
    expect(() =>
      helper.renderRivetDockerfile(
        `${source}\nRUN <<EOF\nFROM scratch AS runner\nEOF\n`,
        profile
      )
    ).toThrow("heredocs");
    expect(() =>
      helper.renderRivetDockerfile(
        `${source}\nRUN true \\\n  <<EOF\nFROM scratch AS runner\nEOF\n`,
        profile
      )
    ).toThrow("heredocs");
    expect(() =>
      helper.renderRivetDockerfile(`${source}\nUNKNOWN instruction\n`, profile)
    ).toThrow("Unsupported root Dockerfile instruction");
    expect(() =>
      helper.renderRivetDockerfile(
        source.replace(
          "ARG SCRUB_RUNNER_CONCURRENCY=2",
          "ARG SCRUB_RUNNER_CONCURRENCY=\\\n2"
        ),
        profile
      )
    ).toThrow("ARG declaration");
    expect(() =>
      helper.renderRivetDockerfile(
        source.replace(
          "FROM ${NODE_IMAGE} AS runner",
          "FROM ${NODE_IMAGE} \\\nAS runner"
        ),
        profile
      )
    ).toThrow("FROM declaration");
  });

  it("writes only the generated output while leaving the source and unrelated files unchanged", async () => {
    const root = await workspace();
    const source = await rootRecipe();
    await writeFile(join(root, "Dockerfile"), source);
    await writeFile(join(root, "sentinel"), "keep");
    let resolvedRoot: string | undefined;
    const output = await helper.prepareRivetImage(root, async (path) => {
      resolvedRoot = path;
      return helper.parseRivetBakeProfile(JSON.stringify(resolvedBake()));
    });
    expect(resolvedRoot).toBe(root);
    expect(output).toBe(join(root, ".local/deploy/Dockerfile.rivet"));
    expect(await readFile(output, "utf8")).toBe(
      helper.renderRivetDockerfile(source, profile)
    );
    expect(await readFile(join(root, "Dockerfile"), "utf8")).toBe(source);
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("keep");
    expect((await readdir(root)).sort()).toEqual([
      ".local",
      "Dockerfile",
      "sentinel",
    ]);
    expect(await readdir(join(root, ".local"))).toEqual(["deploy"]);
    expect(await readdir(join(root, ".local/deploy"))).toEqual([
      "Dockerfile.rivet",
    ]);
  });

  it.each(["", "FROM scratch\n", "ARG SCRUB_DEPENDENCY_HOOK\nRUN true\n"])(
    "rejects an unusable recipe without publishing a deployment file (%j)",
    async (source) => {
      const root = await workspace();
      await writeFile(join(root, "Dockerfile"), source);
      expect(() => helper.renderRivetDockerfile(source, profile)).toThrow(
        "dependency hook"
      );
      await expect(helper.prepareRivetImage(root)).rejects.toThrow(
        "dependency hook"
      );
      expect(await readdir(root)).toEqual(["Dockerfile"]);
      expect(await readFile(join(root, "Dockerfile"), "utf8")).toBe(source);
    }
  );

  it("executes all four Rivet prune groups while retaining required, similar, and unrelated packages", async () => {
    const root = await workspace();
    const app = join(root, "app");
    const removed = [
      "@rivet-dev/agentos-linux-x64",
      "@rivet-dev/agentos-darwin-arm64",
      "@rivet-dev/agent-os-linux-x64",
      "@agentos-software/server",
      "@rivetkit/engine-cli-linux-x64-musl",
      "@rivetkit/engine-cli-darwin-arm64",
    ];
    const retained = [
      "rivetkit",
      "@rivetkit/rivetkit-napi-linux-x64-gnu",
      "@rivetkit/engine-cli",
      "@rivetkit/engine-clients",
      "@rivet-dev/agentos",
      "@rivet-dev/agent-os",
      "@rivet-dev/agentoshelper",
      "@agentos-software-other/server",
      "agentos-linux-x64",
      "zod",
    ];
    for (const name of [...removed, ...retained]) {
      const directory = join(app, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "marker"), name);
    }
    const outside = join(root, "node_modules/@rivet-dev/agentos-linux-x64");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "marker"), "outside app");
    await writeFile(join(app, "sentinel"), "keep");
    const script = join(projectRoot, "deployments/rivet/prune-dependencies.sh");
    await execute("sh", [script], { cwd: app, timeout: 10_000 });
    for (const name of removed)
      await expect(
        readFile(join(app, "node_modules", name, "marker"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of retained)
      expect(
        await readFile(join(app, "node_modules", name, "marker"), "utf8")
      ).toBe(name);
    expect(await readFile(join(outside, "marker"), "utf8")).toBe("outside app");
    expect(await readFile(join(app, "sentinel"), "utf8")).toBe("keep");
    await execute("sh", [script], { cwd: app, timeout: 10_000 });
    expect(
      await readFile(join(app, "node_modules/rivetkit/marker"), "utf8")
    ).toBe("rivetkit");
  });

  it("fails safely when invoked outside an npm installation directory", async () => {
    const root = await workspace();
    await writeFile(join(root, "sentinel"), "keep");
    await expect(
      execute(
        "sh",
        [join(projectRoot, "deployments/rivet/prune-dependencies.sh")],
        { cwd: root, timeout: 10_000 }
      )
    ).rejects.toMatchObject({ code: 1 });
    expect(await readdir(root)).toEqual(["sentinel"]);
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("keep");
  });
});
