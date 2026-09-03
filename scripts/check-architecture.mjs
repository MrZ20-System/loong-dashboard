import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const DEFAULT_RULES = new Set([
  "dsh-import",
  "dsh-manifest",
  "raw-sql",
  "gh-execution",
  "git-execution",
  "circular-dependencies",
  "workspace-dependency-direction",
]);

const RULES = {
  "dsh-import": {
    description: "@deepseek-ai/* imports are allowed only in packages/agent-runtime-dsh/**",
    repair:
      "Move the DSH import into packages/agent-runtime-dsh/** and expose a LoongBoard-owned contract.",
  },
  "dsh-manifest": {
    description: "Non-adapter package manifests must not declare @deepseek-ai/* dependencies",
    repair:
      "Remove the DSH dependency from this manifest and depend on a LoongBoard-owned adapter contract instead.",
  },
  "raw-sql": {
    description: "Raw SQL and SQLite driver access are allowed only in packages/database/**",
    repair:
      "Move SQL and SQLite driver access into packages/database/**; call it through a typed package API.",
  },
  "gh-execution": {
    description: "GitHub CLI execution is allowed only in packages/github/**",
    repair:
      "Move gh execution into packages/github/** and expose a provider method to the caller.",
  },
  "git-execution": {
    description:
      "Git execution is allowed only in packages/git-workspace/** or a Knowledge Git service",
    repair:
      "Move git execution into packages/git-workspace/** or a file-scoped Knowledge Git service.",
  },
  "circular-dependencies": {
    description: "Workspace packages must not have circular runtime dependencies",
    repair: "Remove the dependency cycle and keep dependencies directed from callers to owned services.",
  },
  "workspace-dependency-direction": {
    description:
      "Workspace dependencies must flow from apps to packages and follow the package layer contract",
    repair:
      "Move the dependency to the owning layer or expose a lower-level typed package API.",
  },
};

const WORKSPACE_PACKAGE_RULES = {
  "@loongboard/contracts": new Set(),
  "@loongboard/web": new Set(["@loongboard/contracts"]),
  "@loongboard/server": null,
  "@loongboard/agent-runtime": new Set(["@loongboard/contracts"]),
  "@loongboard/agent-runtime-dsh": new Set([
    "@loongboard/agent-runtime",
    "@loongboard/contracts",
  ]),
  "@loongboard/database": new Set(["@loongboard/contracts"]),
  "@loongboard/github": new Set(["@loongboard/contracts"]),
  "@loongboard/git-workspace": new Set(["@loongboard/contracts"]),
  "@loongboard/knowledge": new Set(["@loongboard/contracts"]),
  "@loongboard/scheduler": new Set([
    "@loongboard/agent-runtime",
    "@loongboard/contracts",
    "@loongboard/database",
  ]),
};

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isIgnoredDirectory(name) {
  return new Set([
    ".git",
    ".codegraph",
    ".loong",
    ".worktrees",
    "coverage",
    "dist",
    "node_modules",
    ".pnpm",
  ]).has(name);
}

function walk(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(entry.name)) {
        files.push(...walk(path.join(directory, entry.name)));
      }
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function sourceFiles(root) {
  return ["apps", "packages", "scripts", "tests"]
    .flatMap((directory) => walk(path.join(root, directory)))
    .filter((filePath) => {
      const relative = relativePath(root, filePath);
      return relative !== "scripts/check-architecture.mjs" &&
        relative !== "scripts/check-architecture.test.mjs";
    });
}

function violation(file, rule) {
  return {
    file,
    rule,
    description: RULES[rule].description,
    repair: RULES[rule].repair,
  };
}

function isUnder(relative, directory) {
  return relative === directory || relative.startsWith(`${directory}/`);
}

function hasDshImport(source) {
  return /(?:import\s+(?:[^"'`]+?\s+from\s+)?|export\s+[^"'`]+?\s+from\s+|(?:require|import)\s*\(\s*)["'`]@deepseek-ai\/[^"'`]+["'`]/m.test(
    source,
  );
}

function hasRawSql(source) {
  return (
    /["'`]\s*(?:SELECT\b|INSERT\b|UPDATE\b|DELETE\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|DROP\s+TABLE\b|PRAGMA\b)/i.test(source) ||
    /(?:better-sqlite3|drizzle-orm\/sqlite|\.prepare\s*\(|\bsql\s*`)/i.test(source)
  );
}

function hasGhExecution(source) {
  return (
    /(?:spawn|exec|execFile|execa|command)\s*\(\s*["'`]gh(?:\.exe)?(?:["'`]|\s)/i.test(
      source,
    ) ||
    /["'`]gh\s+(?:api|auth|issue|pr|repo|run|search)\b/i.test(source)
  );
}

function hasGitExecution(source) {
  return (
    /(?:spawn|exec|execFile|execa|command)\s*\(\s*["'`]git(?:\.exe)?(?:["'`]|\s)/i.test(
      source,
    ) ||
    /["'`]git\s+(?:add|branch|checkout|clone|commit|diff|fetch|log|pull|push|show|status|switch|worktree)\b/i.test(
      source,
    )
  );
}

function isGitExecutionAllowed(relative) {
  if (isUnder(relative, "packages/git-workspace")) {
    return true;
  }

  return isUnder(relative, "packages/knowledge") && /(?:^|\/)git(?:[-/]|$)/i.test(relative);
}

function findBoundaryViolations(root, rules) {
  const violations = [];
  for (const filePath of sourceFiles(root)) {
    const relative = relativePath(root, filePath);
    const source = fs.readFileSync(filePath, "utf8");

    if (rules.has("dsh-import") && hasDshImport(source) && !isUnder(relative, "packages/agent-runtime-dsh")) {
      violations.push(violation(relative, "dsh-import"));
    }

    if (rules.has("raw-sql") && hasRawSql(source) && !isUnder(relative, "packages/database")) {
      violations.push(violation(relative, "raw-sql"));
    }

    if (rules.has("gh-execution") && hasGhExecution(source) && !isUnder(relative, "packages/github")) {
      violations.push(violation(relative, "gh-execution"));
    }

    if (
      rules.has("git-execution") &&
      hasGitExecution(source) &&
      !isGitExecutionAllowed(relative)
    ) {
      violations.push(violation(relative, "git-execution"));
    }
  }
  return violations;
}

function packageManifests(root) {
  const manifests = [];
  for (const directory of ["apps", "packages"]) {
    const base = path.join(root, directory);
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const filePath = path.join(base, entry.name, "package.json");
      if (fs.existsSync(filePath)) {
        manifests.push(filePath);
      }
    }
  }
  return manifests;
}

function declaredDependencies(manifest, sections = ["dependencies", "optionalDependencies"]) {
  const dependencies = new Set();
  for (const section of sections) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      dependencies.add(name);
    }
  }
  return dependencies;
}

function findManifestViolations(root) {
  const manifests = packageManifests(root);
  const workspaceNames = new Set();
  const entries = [];

  for (const filePath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string") {
      continue;
    }
    workspaceNames.add(manifest.name);
    entries.push({ filePath, manifest });
  }

  const violations = [];
  for (const { filePath, manifest } of entries) {
    const relative = relativePath(root, filePath);
    const allDeclaredDependencies = declaredDependencies(manifest, [
      "dependencies",
      "optionalDependencies",
      "devDependencies",
      "peerDependencies",
    ]);
    if (
      !isUnder(relative, "packages/agent-runtime-dsh") &&
      [...allDeclaredDependencies].some((name) => name.startsWith("@deepseek-ai/"))
    ) {
      violations.push(violation(relative, "dsh-manifest"));
    }

    if (!isUnder(relative, "apps") && !isUnder(relative, "packages")) {
      continue;
    }

    const ownerRules = WORKSPACE_PACKAGE_RULES[manifest.name];
    if (ownerRules === undefined) {
      continue;
    }

    const workspaceDependencies = [...declaredDependencies(manifest)].filter((name) =>
      workspaceNames.has(name),
    );
    const disallowed = ownerRules === null
      ? workspaceDependencies.filter((name) => name === "@loongboard/web")
      : workspaceDependencies.filter((name) => !ownerRules.has(name));
    for (const dependency of disallowed) {
      const item = violation(relative, "workspace-dependency-direction");
      item.description = `${item.description}: ${manifest.name} -> ${dependency}`;
      violations.push(item);
    }
  }

  return violations;
}

function findPackageCycles(root) {
  const graph = new Map();
  const manifestByName = new Map();

  for (const filePath of packageManifests(root)) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string") {
      continue;
    }
    manifestByName.set(manifest.name, relativePath(root, filePath));
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    graph.set(
      manifest.name,
      Object.keys(dependencies).filter((name) => name.startsWith("@loongboard/")),
    );
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  function visit(name) {
    if (visiting.has(name)) {
      const start = stack.indexOf(name);
      cycles.push([...stack.slice(start), name]);
      return;
    }
    if (visited.has(name)) {
      return;
    }

    visiting.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of graph.keys()) {
    visit(name);
  }

  return cycles.map((cycle) => ({
    file: manifestByName.get(cycle[0]) ?? "package.json",
    rule: "circular-dependencies",
    description: `${RULES["circular-dependencies"].description}: ${cycle.join(" -> ")}`,
    repair: RULES["circular-dependencies"].repair,
  }));
}

export function checkArchitecture(root, { rules = DEFAULT_RULES } = {}) {
  const selectedRules = new Set(rules);
  for (const rule of selectedRules) {
    if (!RULES[rule]) {
      throw new Error(`Unknown architecture rule: ${rule}`);
    }
  }

  const violations = findBoundaryViolations(root, selectedRules);
  if (selectedRules.has("dsh-manifest") || selectedRules.has("workspace-dependency-direction")) {
    const manifestRules = new Set();
    if (selectedRules.has("dsh-manifest")) {
      manifestRules.add("dsh-manifest");
    }
    if (selectedRules.has("workspace-dependency-direction")) {
      manifestRules.add("workspace-dependency-direction");
    }
    violations.push(
      ...findManifestViolations(root).filter((item) => manifestRules.has(item.rule)),
    );
  }
  if (selectedRules.has("circular-dependencies")) {
    violations.push(...findPackageCycles(root));
  }
  return violations;
}

export const findViolations = checkArchitecture;

function parseArguments(argumentsList) {
  let root = process.cwd();
  let rules = DEFAULT_RULES;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--root") {
      root = path.resolve(argumentsList[index + 1] ?? "");
      index += 1;
    } else if (argument === "--rule") {
      rules = new Set((argumentsList[index + 1] ?? "").split(",").filter(Boolean));
      index += 1;
    }
  }
  return { root, rules };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { root, rules } = parseArguments(process.argv.slice(2));
  const violations = checkArchitecture(root, { rules });
  if (violations.length > 0) {
    console.error("Architecture boundary check failed:");
    for (const item of violations) {
      console.error(`- file: ${item.file}`);
      console.error(`  rule: ${item.description}`);
      console.error(`  repair: ${item.repair}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Architecture boundary checks passed.");
  }
}
