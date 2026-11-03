// Builds the publishable npm package into packages/kit/dist, then `npm publish packages/kit/dist`.
// Why a build: Node will not run .ts under node_modules, and the @t3tools/* workspace packages are
// private, so everything in the workspace is bundled and only real npm packages stay as dependencies.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const kitDir = path.join(packagesDir, "kit");
const out = path.join(kitDir, "dist");
const typesDir = path.join(out, "types");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const kit = readJson(path.join(kitDir, "package.json"));

const workspace = new Map(); // package name -> { dir, exports }
for (const dir of fs.readdirSync(packagesDir)) {
  const file = path.join(packagesDir, dir, "package.json");
  if (fs.existsSync(file)) workspace.set(readJson(file).name, { dir, exports: readJson(file).exports ?? {} });
}
workspace.delete(kit.name);

// Third-party packages bundled too: @opencode/* pins its own `effect`, and npm would install that as a
// second copy next to ours (pnpm.overrides in the monorepo hide this; npm ignores overrides in dependencies).
const bundledThirdParty = new Set(["@opencode/client", "@opencode/protocol", "@opencode/schema"]);
const packageName = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
const isBuiltin = (spec) => spec.startsWith("node:") || builtinModules.includes(packageName(spec));
const exportTarget = (spec) => {
  const name = packageName(spec);
  const entry = workspace.get(name)?.exports["." + spec.slice(name.length)];
  const target = typeof entry === "string" ? entry : (entry?.types ?? entry?.import ?? entry?.default);
  return target === undefined ? undefined : path.join(packagesDir, workspace.get(name).dir, target);
};

fs.rmSync(out, { recursive: true, force: true });

// 1. JS: one ESM bundle per entry. bin and claude-history-worker are the helper scripts the code
//    spawns next to itself (DocumentText, ClaudeAdapterV2), so they must sit beside the chunks.
const result = await build({
  entryPoints: {
    index: path.join(kitDir, "src/index.ts"),
    effect: path.join(kitDir, "src/effect.ts"),
    bin: path.join(packagesDir, "providers/src/bin.ts"),
    "claude-history-worker": path.join(packagesDir, "providers/src/claude-history-worker.ts"),
  },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  metafile: true,
  logLevel: "warning",
  plugins: [
    {
      name: "workspace-only",
      setup: (b) =>
        b.onResolve({ filter: /^[^./#]/ }, (args) =>
          workspace.has(packageName(args.path)) || bundledThirdParty.has(packageName(args.path)) || isBuiltin(args.path)
            ? undefined
            : { external: true },
        ),
    },
  ],
});
const dependencies = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !isBuiltin(imported.path)) dependencies.add(packageName(imported.path));
  }
}

// 2. Types: emit with workspace specifiers mapped to their sources (otherwise tsc skips them as
//    external libraries), then rewrite every import to a relative path inside dist/types.
const paths = {};
for (const [name, { dir, exports }] of workspace) {
  for (const subpath of Object.keys(exports)) paths[name + subpath.slice(1)] = [exportTarget(name + subpath.slice(1))];
}
const tsconfig = path.join(kitDir, "tsconfig.types.json");
fs.writeFileSync(
  tsconfig,
  JSON.stringify({
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      types: ["node"], noEmit: false, declaration: true, emitDeclarationOnly: true, incremental: false,
      stripInternal: true, outDir: "dist/types", rootDir: "..", paths,
    },
    include: ["src"],
  }),
);
try {
  const tsc = spawnSync(path.join(root, "node_modules/.bin/tsc"), ["-p", tsconfig], { cwd: root, encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`Declaration emit failed:\n${(tsc.stdout + tsc.stderr).slice(0, 4000)}`);
} finally {
  fs.rmSync(tsconfig);
}

// Matches `import ... from "x"`, `export ... from "x"`, `import "x"` at line start, and `import("x")` types.
// Anchoring to statements keeps string-literal types such as "externalAgentConfig/import" out.
const specifierPattern = /(^(?:import|export)\b[^"'\n]*?\bfrom\s*|^import\s*|\bimport\(\s*)(["'])([^"'\n]+)\2/gm;

const files = new Map(); // d.ts path -> { text, links: d.ts paths it imports }
const typeDependencies = new Set();
const missing = [];
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const toDts = (source) => path.join(typesDir, path.relative(packagesDir, source).replace(/\.tsx?$/, ".d.ts"));
for (const file of walk(typesDir).filter((f) => f.endsWith(".d.ts"))) {
  const links = [];
  const text = fs.readFileSync(file, "utf8").replace(specifierPattern, (whole, lead, quote, spec) => {
    let target;
    if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec.replace(/\.tsx?$/, ".d.ts"));
    else if (workspace.has(packageName(spec))) {
      const source = exportTarget(spec);
      target = source === undefined ? undefined : toDts(source);
    } else {
      if (!isBuiltin(spec)) typeDependencies.add(packageName(spec));
      return whole;
    }
    if (target === undefined || !fs.existsSync(target)) {
      missing.push(`${path.relative(typesDir, file)} -> ${spec}`);
      return whole;
    }
    links.push(target);
    const relative = path.relative(path.dirname(file), target).replace(/\.d\.ts$/, ".js");
    return `${lead}${quote}${relative.startsWith(".") ? relative : "./" + relative}${quote}`;
  });
  files.set(file, { text, links });
}
// Keep only what the two entry types can reach; the rest is internal and would drag in extra dependencies.
const reachable = new Set();
const queue = ["index", "effect"].map((entry) => path.join(typesDir, "kit/src", `${entry}.d.ts`));
for (const file of queue) {
  if (reachable.has(file)) continue;
  reachable.add(file);
  queue.push(...files.get(file).links);
}
const unresolved = missing.filter((m) => reachable.has(path.join(typesDir, m.split(" -> ")[0])));
if (unresolved.length > 0) throw new Error(`Unresolved type imports:\n${unresolved.slice(0, 20).join("\n")}`);
typeDependencies.clear();
for (const [file, { text }] of files) {
  if (!reachable.has(file)) fs.rmSync(file);
  else {
    fs.writeFileSync(file, text);
    for (const [, , , spec] of text.matchAll(specifierPattern)) {
      if (!spec.startsWith(".") && !isBuiltin(spec) && !workspace.has(packageName(spec))) typeDependencies.add(packageName(spec));
    }
  }
}
for (const dir of walk(typesDir).map(path.dirname)) if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);

// 3. Manifest: exact installed versions, because Effect packages must match each other exactly.
const installedVersion = (name) => {
  const candidates = [root, ...[...workspace.values()].map((w) => path.join(packagesDir, w.dir)), kitDir];
  for (const base of candidates) {
    const file = path.join(base, "node_modules", name, "package.json");
    if (fs.existsSync(file)) return readJson(file).version;
  }
  throw new Error(`Cannot find an installed version of ${name}`);
};
// SDK peer dependencies are explicit package dependencies so a consumer can keep Zod 3
// while this package supplies Zod 4 to the Claude Agent SDK.
// Transitive packages the monorepo pins with pnpm.overrides. Declared directly, so npm dedupes to one copy.
const rootOverrides = readJson(path.join(root, "package.json")).pnpm?.overrides ?? {};
const pinned = { "@effect/platform-node-shared": rootOverrides["@effect/platform-node-shared"] };
const allDependencies = [...new Set([...dependencies, ...typeDependencies, ...Object.keys(pinned), "zod", "@modelcontextprotocol/sdk", "@anthropic-ai/sdk"])].sort();
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: kit.name,
      version: kit.version,
      description: kit.description,
      license: kit.license,
      repository: { type: "git", url: "git+https://github.com/shakthi-sagar/agent-provider-kit.git" },
      homepage: "https://github.com/shakthi-sagar/agent-provider-kit#readme",
      type: "module",
      engines: kit.engines,
      exports: {
        ".": { types: "./types/kit/src/index.d.ts", default: "./index.mjs" },
        "./effect": { types: "./types/kit/src/effect.d.ts", default: "./effect.mjs" },
      },
      dependencies: Object.fromEntries(allDependencies.map((name) => [name, pinned[name] ?? installedVersion(name)])),
    },
    null,
    2,
  ) + "\n",
);
for (const doc of ["README.md", "LICENSE", "UPSTREAM.md", "SESSION_SUPPORT.md"]) fs.copyFileSync(path.join(root, doc), path.join(out, doc));
console.log(`Built ${kit.name}@${kit.version} -> ${path.relative(root, out)} (${allDependencies.length} dependencies, ${reachable.size} type files)`);
