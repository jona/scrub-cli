import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const supportedInstructions = new Set([
  "FROM",
  "ARG",
  "RUN",
  "CMD",
  "LABEL",
  "MAINTAINER",
  "EXPOSE",
  "ENV",
  "ADD",
  "COPY",
  "ENTRYPOINT",
  "VOLUME",
  "USER",
  "WORKDIR",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
]);

function publicArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error(
      "The Bake profile must resolve explicit public argument values"
    );
  const entries = Object.entries(args);
  for (const [name, value] of entries) {
    if (
      !safeName.test(name) ||
      /KEY|TOKEN|SECRET|PASSWORD/i.test(name) ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value)
    )
      throw new Error(
        "The Bake profile contains an unsafe or unresolved build argument"
      );
  }
  return entries;
}

/** Conservative Dockerfile inspection: fail rather than guess at unsupported syntax. */
function rootRecipe(source) {
  const lines = source.split(/(?<=\n)/);
  const declarations = [];
  const stages = [];
  let escape = "\\";
  let header = true;
  let continuation = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r?\n$/, "");
    if (header) {
      const directive = /^#\s*escape\s*=\s*([\\`])\s*$/i.exec(line);
      if (directive) escape = directive[1];
      if (!line.startsWith("#")) header = false;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/<</.test(line))
      throw new Error(
        "Dockerfile heredocs are unsupported by the CLI compatibility generator"
      );
    if (continuation) {
      continuation = line.trimEnd().endsWith(escape);
      continue;
    }
    const instruction = /^\s*([A-Za-z]+)\s+(.+)$/.exec(line);
    if (!instruction) throw new Error("Unsupported root Dockerfile structure");
    const keyword = instruction[1].toUpperCase();
    if (!supportedInstructions.has(keyword))
      throw new Error("Unsupported root Dockerfile instruction");
    continuation = line.trimEnd().endsWith(escape);
    if (keyword === "ARG") {
      const declaration =
        /^(\s*ARG\s+)([A-Za-z_][A-Za-z0-9_]*)(?:\s*=.*)?\s*$/i.exec(line);
      if (!declaration || continuation)
        throw new Error("Unsupported Dockerfile ARG declaration");
      declarations.push({
        index,
        prefix: declaration[1],
        name: declaration[2],
      });
    } else if (keyword === "FROM") {
      const stage =
        /^FROM\s+(?:--platform=\S+\s+)?\S+(?:\s+AS\s+([A-Za-z0-9][A-Za-z0-9_.-]*))?\s*$/i.exec(
          line.trim()
        );
      if (!stage || continuation)
        throw new Error("Unsupported Dockerfile FROM declaration");
      stages.push(stage[1]);
    }
  }
  if (continuation) throw new Error("Incomplete root Dockerfile instruction");
  if (
    !stages.length ||
    !declarations.some(({ name }) => name === "SCRUB_DEPENDENCY_HOOK")
  )
    throw new Error("Dockerfile must expose the deployment dependency hook");
  const named = stages.filter(Boolean).map((name) => name.toLowerCase());
  if (new Set(named).size !== named.length)
    throw new Error("Duplicate Dockerfile stage names are unsupported");
  return { lines, declarations, finalStage: stages.at(-1), escape };
}

function quotedValue(value, escape) {
  // Dockerfile's lexer expands $ in double quotes. Escape it, quotes and the
  // active escape token so JSON, whitespace and literal references survive.
  return `"${Array.from(value, (character) =>
    character === escape || character === "$" || character === '"'
      ? escape + character
      : character
  ).join("")}"`;
}

/** Resolve the normal build profile without starting a Docker build or daemon. */
export async function resolveRivetBakeProfile(root) {
  let stdout;
  try {
    ({ stdout } = await execute(
      "docker",
      ["buildx", "bake", "--file", "docker-bake.hcl", "--print", "rivet-api"],
      { cwd: root, maxBuffer: 1024 * 1024, timeout: 30_000 }
    ));
  } catch {
    throw new Error(
      "Docker Buildx must resolve the rivet-api Bake profile before preparing the CLI fallback"
    );
  }
  return parseRivetBakeProfile(stdout);
}

export function parseRivetBakeProfile(source) {
  let profile;
  try {
    profile = JSON.parse(source)?.target?.["rivet-api"];
  } catch {
    /* handled below */
  }
  const args = profile?.args;
  if (
    profile?.context !== "." ||
    profile?.dockerfile !== "Dockerfile" ||
    profile?.target !== "runner" ||
    profile?.platforms?.length !== 1 ||
    profile.platforms[0] !== "linux/amd64" ||
    args?.SCRUB_ENTRYPOINT !== "dist/deployments/rivet/main.js" ||
    args?.SCRUB_DEPENDENCY_HOOK !== "rivet/prune-dependencies.sh"
  )
    throw new Error(
      "The rivet-api Bake profile must select the root recipe, runner stage, Linux AMD64, and Rivet composition/hook"
    );
  return {
    target: profile.target,
    args: Object.fromEntries(publicArguments(args)),
  };
}

export function renderRivetDockerfile(source, profile) {
  const recipe = rootRecipe(source);
  if (
    profile?.target !== "runner" ||
    profile?.args?.SCRUB_ENTRYPOINT !== "dist/deployments/rivet/main.js" ||
    profile?.args?.SCRUB_DEPENDENCY_HOOK !== "rivet/prune-dependencies.sh"
  )
    throw new Error("A resolved rivet-api Bake profile is required");
  if (recipe.finalStage !== profile.target)
    throw new Error(
      "The Bake runner target must be the final root Dockerfile stage for CLI compatibility"
    );
  const entries = publicArguments(profile.args);
  const declared = new Set(recipe.declarations.map(({ name }) => name));
  if (entries.some(([name]) => !declared.has(name)))
    throw new Error(
      "The Bake profile contains an argument not declared by the root Dockerfile"
    );
  // Override every declaration, including independent stages and explicit
  // in-stage defaults. A prepended global ARG cannot override those defaults.
  for (const declaration of recipe.declarations) {
    if (!Object.hasOwn(profile.args, declaration.name)) continue;
    const original = recipe.lines[declaration.index];
    const ending = original.endsWith("\r\n")
      ? "\r\n"
      : original.endsWith("\n")
        ? "\n"
        : "";
    recipe.lines[declaration.index] =
      `${declaration.prefix}${declaration.name}=${quotedValue(profile.args[declaration.name], recipe.escape)}${ending}`;
  }
  return `${recipe.lines.join("").trimEnd()}\n\nENV SCRUB_ENTRYPOINT=${quotedValue(profile.args.SCRUB_ENTRYPOINT, recipe.escape)}\n`;
}

export async function prepareRivetImage(
  root = fileURLToPath(new URL("../../", import.meta.url)),
  resolveProfile = resolveRivetBakeProfile
) {
  const source = await readFile(resolve(root, "Dockerfile"), "utf8");
  // Reject an unusable root recipe before invoking build tooling.
  rootRecipe(source);
  const generated = renderRivetDockerfile(source, await resolveProfile(root));
  const output = resolve(root, ".local/deploy/Dockerfile.rivet");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, generated, { mode: 0o600 });
  return output;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareRivetImage();
  console.log("Prepared .local/deploy/Dockerfile.rivet");
}
