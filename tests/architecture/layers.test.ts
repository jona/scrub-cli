import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(projectRoot, "src");
const configPath = join(projectRoot, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
  );
const { options } = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  projectRoot
);

/** Include type-only and lazy dependencies without treating comments as imports. */
function moduleSpecifiers(source: string, fileName = "example.ts"): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const dependencies: string[] = [];
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) dependencies.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return dependencies;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?tsx?$/.test(entry.name)
        ? [path]
        : [];
  });
}

const sourcePath = (file: string) =>
  relative(sourceRoot, file).split(sep).join("/");
const inLayer = (file: string, layer: string) => file.startsWith(`${layer}/`);
const isRivetSdk = (name: string) =>
  name === "rivetkit" ||
  name.startsWith("rivetkit/") ||
  name.startsWith("@rivetkit/") ||
  name.startsWith("@rivet-dev/");

const nodeModules = new Set(
  builtinModules.map((name) => name.replace(/^node:/, ""))
);
const nodeGlobals = new Set([
  "NodeJS",
  "process",
  "Buffer",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "global",
  "setImmediate",
  "clearImmediate",
]);

/** Runtime restrictions apply to type references and computed access too. */
function portableHazards(source: string, fileName = "example.ts"): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const hazards: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && nodeGlobals.has(node.text)) {
      const parent = node.parent;
      const ordinaryProperty =
        (ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          !(
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === "globalThis"
          )) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodDeclaration(parent)) &&
          parent.name === node);
      if (!ordinaryProperty) hazards.push(`Node global ${node.text}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      nodeGlobals.has(node.argumentExpression.text)
    ) {
      hazards.push(`Node global globalThis[${node.argumentExpression.text}]`);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !ts.isStringLiteralLike(node.arguments[0])
    )
      hazards.push("nonliteral dynamic import");
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date" &&
      node.expression.name.text === "now"
    )
      hazards.push("ambient Date.now");
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      !node.arguments?.length
    )
      hazards.push("ambient new Date");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hazards;
}

describe("architecture boundaries", () => {
  it("recognizes Node globals and hidden dynamic loads without scanning comments", () => {
    expect(
      portableHazards(`
      process.env; Buffer.from("data"); globalThis["process"];
      const load = (name: string) => import(name);
      Date.now(); new Date();
      const allowed = { process: "a business field" }; allowed.process;
      // process.env; require("node:fs");
    `)
    ).toEqual([
      "Node global process",
      "Node global Buffer",
      "Node global globalThis[process]",
      "nonliteral dynamic import",
      "ambient Date.now",
      "ambient new Date",
    ]);
  });

  it("discovers static, exported, type-only, and lazy import forms", () => {
    expect(
      moduleSpecifiers(`
      import "side-effect";
      import type { Value } from "static-type";
      export { Value } from "reexport";
      export type { Value } from "type-reexport";
      export * from "barrel";
      import legacy = require("import-equals");
      const lazy = () => import("lazy");
      const legacyLazy = require("require-call");
      type Imported = import("import-type").Value;
      type Module = typeof import("typeof-import");
      // import "comment";
      const example = 'require("plain-string")';
    `)
    ).toEqual([
      "side-effect",
      "static-type",
      "reexport",
      "type-reexport",
      "barrel",
      "import-equals",
      "lazy",
      "require-call",
      "import-type",
      "typeof-import",
    ]);
  });

  it("keeps business code, interfaces, and provider composition separated", () => {
    const files = sourceFiles(sourceRoot);
    const graph = new Map<string, string[]>();
    const violations: string[] = [];

    for (const file of files) {
      const from = sourcePath(file);
      const portable =
        inLayer(from, "core") ||
        inLayer(from, "application") ||
        from === "index.ts";
      const targets: string[] = [];
      graph.set(from, targets);
      if (portable) {
        for (const hazard of portableHazards(readFileSync(file, "utf8"), file))
          violations.push(`${from}: ${hazard}`);
      }
      for (const specifier of moduleSpecifiers(
        readFileSync(file, "utf8"),
        file
      )) {
        // Resolve .js imports to their TypeScript sources, including path aliases.
        const imported = ts.resolveModuleName(
          specifier,
          file,
          options,
          ts.sys
        ).resolvedModule;
        if (
          portable &&
          (specifier.startsWith("node:") || nodeModules.has(specifier))
        )
          violations.push(`${from} imports Node module ${specifier}`);
        if (
          portable &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("/") &&
          specifier !== "zod"
        )
          violations.push(
            `${from} imports nonportable dependency ${specifier}`
          );
        const sdk =
          isRivetSdk(specifier) ||
          (imported?.packageId && isRivetSdk(imported.packageId.name));
        if (
          sdk &&
          !inLayer(from, "infrastructure/rivet") &&
          !inLayer(from, "deployments/rivet")
        ) {
          violations.push(`${from} imports Rivet SDK ${specifier}`);
        }
        if (!imported) {
          if (specifier.startsWith(".") || specifier.startsWith("/")) {
            violations.push(`${from} has unresolved local import ${specifier}`);
          }
          continue;
        }
        const target = sourcePath(imported.resolvedFileName);
        if (portable && specifier !== "zod" && target.startsWith("../")) {
          violations.push(
            `${from} resolves outside the portable source boundary: ${specifier}`
          );
        }
        if (!target.startsWith("../") && !target.startsWith("..\\"))
          targets.push(target);
      }
    }

    for (const from of graph.keys()) {
      const business = ["core", "services", "orchestrators"].some((layer) =>
        inLayer(from, layer)
      );
      const portable =
        inLayer(from, "core") ||
        inLayer(from, "application") ||
        from === "index.ts";
      const entrypoint = inLayer(from, "entrypoints");
      const provider = inLayer(from, "infrastructure/rivet");
      const forbidden = [
        ...(business || entrypoint
          ? ["infrastructure/rivet", "deployments"]
          : []),
        ...(business || provider ? ["entrypoints"] : []),
        ...(provider ? ["deployments"] : []),
      ];
      // Follow barrels too: moving a forbidden import to a helper cannot hide it.
      const pending = (graph.get(from) ?? []).map((target) => [from, target]);
      const visited = new Set<string>([from]);
      while (pending.length) {
        const chain = pending.pop()!;
        const target = chain[chain.length - 1];
        if (visited.has(target)) continue;
        visited.add(target);
        if (
          portable &&
          !(inLayer(target, "core") || inLayer(target, "application"))
        ) {
          violations.push(chain.join(" -> "));
          continue;
        }
        if (inLayer(from, "core") && inLayer(target, "application")) {
          violations.push(chain.join(" -> "));
          continue;
        }
        if (forbidden.some((layer) => inLayer(target, layer))) {
          violations.push(chain.join(" -> "));
          continue;
        }
        for (const next of graph.get(target) ?? [])
          pending.push([...chain, next]);
      }
    }

    expect(
      violations,
      "Dependencies crossed an application/provider boundary"
    ).toEqual([]);
  });
});
