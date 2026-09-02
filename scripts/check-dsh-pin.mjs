import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const EXPECTED_VERSION = "0.1.2-alpha.5";
const EXPECTED_TAG = "dsh-v0.1.2-alpha.5";
const EXPECTED_MASTER = "49a606bc5b5934603f22a26957a07dc799ab0291";

function fail(file, rule, repair) {
  console.error("DSH pin check failed:");
  console.error(`- file: ${file}`);
  console.error(`  rule: ${rule}`);
  console.error(`  repair: ${repair}`);
  process.exitCode = 1;
}

const root = process.cwd();
const lockPath = path.join(root, "dsh.lock.json");
const packagePath = path.join(root, "packages/agent-runtime-dsh/package.json");
const pnpmLockPath = path.join(root, "pnpm-lock.yaml");

if (!fs.existsSync(lockPath)) {
  fail("dsh.lock.json", "the DSH release lock is required", "Add the exact dsh-v0.1.2-alpha.5 lock record.");
} else if (!fs.existsSync(packagePath)) {
  fail(
    "packages/agent-runtime-dsh/package.json",
    "the DSH adapter package is required",
    "Create the adapter package with the exact SDK dependencies.",
  );
} else {
  let lock;
  let manifest;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    fail(
      "dsh.lock.json or packages/agent-runtime-dsh/package.json",
      `the DSH lock and manifest must be valid JSON (${error.message})`,
      "Fix the JSON without changing the exact release pin.",
    );
    lock = null;
    manifest = null;
  }

  const lockMatches =
    lock?.version === EXPECTED_VERSION &&
    lock?.tag === EXPECTED_TAG &&
    lock?.masterInspected === EXPECTED_MASTER &&
    lock?.packages?.["@deepseek-ai/dsh"] === EXPECTED_VERSION &&
    lock?.packages?.["@deepseek-ai/dsh-sdk-client"] === EXPECTED_VERSION;
  const manifestMatches =
    manifest?.dependencies?.["@deepseek-ai/dsh"] === EXPECTED_VERSION &&
    manifest?.dependencies?.["@deepseek-ai/dsh-sdk-client"] === EXPECTED_VERSION;
  let pnpmLockMatches = false;
  if (fs.existsSync(pnpmLockPath)) {
    const pnpmLock = fs.readFileSync(pnpmLockPath, "utf8");
    const importerStart = pnpmLock.indexOf("  packages/agent-runtime-dsh:\n");
    const packageSectionStart = pnpmLock.indexOf("\npackages:\n", importerStart);
    const importer =
      importerStart >= 0
        ? pnpmLock.slice(
            importerStart,
            packageSectionStart >= 0 ? packageSectionStart : pnpmLock.length,
          )
        : "";

    const importerVersion = (name) => {
      const key = `      '${name}':`;
      const keyStart = importer.indexOf(key);
      if (keyStart < 0) {
        return null;
      }
      const entry = importer.slice(keyStart, importer.indexOf("\n      '", keyStart + key.length));
      const specifier = entry.match(/\n        specifier: ([^\n]+)/)?.[1];
      const version = entry.match(/\n        version: ([^\n]+)/)?.[1];
      return { specifier, version };
    };

    const dshImporter = importerVersion("@deepseek-ai/dsh");
    const sdkImporter = importerVersion("@deepseek-ai/dsh-sdk-client");
    const exactVersion = (entry) =>
      entry?.specifier === EXPECTED_VERSION &&
      (entry.version === EXPECTED_VERSION || entry.version?.startsWith(`${EXPECTED_VERSION}(`));
    pnpmLockMatches = exactVersion(dshImporter) && exactVersion(sdkImporter);
  }

  if (!lockMatches) {
    fail(
      "dsh.lock.json",
      "the DSH release and SDK versions must be exact",
      "Restore version 0.1.2-alpha.5, tag dsh-v0.1.2-alpha.5, and the recorded master commit.",
    );
  }
  if (!manifestMatches) {
    fail(
      "packages/agent-runtime-dsh/package.json",
      "the DSH SDK dependencies must be exact 0.1.2-alpha.5",
      "Pin both @deepseek-ai/dsh packages to 0.1.2-alpha.5 without a range.",
    );
  }
  if (!pnpmLockMatches) {
    fail(
      "pnpm-lock.yaml",
      "the DSH importer must resolve both SDK packages to exact 0.1.2-alpha.5",
      "Refresh the lockfile after pinning packages/agent-runtime-dsh/package.json.",
    );
  }
  if (process.exitCode !== 1) {
    console.log("DSH release pin checks passed.");
  }
}
