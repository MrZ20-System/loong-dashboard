import {
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  personalDataImportSchema,
  personalDataInstructionTreeRefreshResponseSchema,
  personalDataStatusSchema,
  type PersonalDataImport,
  type PersonalDataInstructionTreeRefreshResponse,
  type PersonalDataStatus,
} from "@loongboard/contracts";
import {
  RepositoryOnboardingError,
  RepositoryOnboardingGit,
  type RepositoryCredential,
  type RepositoryOnboardingInput as GitRepositoryInput,
} from "@loongboard/git-workspace";
import { atomicWrite } from "@loongboard/knowledge";
import { tree, type Options as TreeOptions } from "tree-node-cli";

const PERSONAL_DATA_REMOTE = "origin";
const REQUIRED_DIRECTORIES = ["knowledge", "prompts", "skills"] as const;
const INSTRUCTION_TREE_DIRECTORY = "_loongboard";
const INSTRUCTION_TREE_FILE = "instruction-tree.md";

type PersonalDataTreeRenderer = (path: string, options?: TreeOptions) => string;

export interface PersonalDataServiceOptions {
  /** Absolute Personal Data Git repository root from server config. */
  personalPath: string;
  /** Absolute knowledge directory inside personalPath from server config. */
  knowledgePath: string;
  /** Existing secure Git adapter; omitted only for the production default. */
  gitWorkspace?: Pick<RepositoryOnboardingGit, "clone">;
  /** Resolves the existing GitHub credential without persisting it here. */
  credentialToken?: () => Promise<string | null> | string | null;
  /** Injectable only for focused tests; production uses tree-node-cli's tree API. */
  treeRenderer?: PersonalDataTreeRenderer;
  now?: () => Date;
}

export class PersonalDataImportConflictError extends Error {
  readonly code = "PERSONAL_DATA_IMPORT_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersonalDataImportConflictError";
  }
}

export class PersonalDataImportError extends Error {
  readonly code = "PERSONAL_DATA_IMPORT_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersonalDataImportError";
  }
}

export class PersonalDataUnavailableError extends Error {
  readonly code = "PERSONAL_DATA_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "PersonalDataUnavailableError";
  }
}

/**
 * Synchronous Personal Data import and deterministic instruction-tree
 * projection. The destination is injected by the server and never accepted
 * from an HTTP request.
 */
export class PersonalDataService {
  private readonly personalPath: string;
  private readonly knowledgePath: string;
  private readonly instructionTreePath: string;
  private readonly gitWorkspace: Pick<RepositoryOnboardingGit, "clone">;
  private readonly credentialToken: PersonalDataServiceOptions["credentialToken"];
  private readonly treeRenderer: PersonalDataTreeRenderer;
  private readonly now: () => Date;

  constructor(options: PersonalDataServiceOptions) {
    this.personalPath = resolve(options.personalPath);
    this.knowledgePath = resolve(options.knowledgePath);
    this.instructionTreePath = join(
      this.knowledgePath,
      INSTRUCTION_TREE_DIRECTORY,
      INSTRUCTION_TREE_FILE,
    );
    this.gitWorkspace = options.gitWorkspace ?? new RepositoryOnboardingGit();
    this.credentialToken = options.credentialToken;
    this.treeRenderer = options.treeRenderer ?? tree;
    this.now = options.now ?? (() => new Date());
    assertStrictDescendant(this.personalPath, this.knowledgePath);
    assertSafePathAncestors(this.personalPath, "Personal Data path");
    assertSafePathAncestors(this.knowledgePath, "Personal Data knowledge path");
  }

  getStatus(): PersonalDataStatus {
    const available = this.hasRequiredDirectories();
    return personalDataStatusSchema.parse({
      path: this.personalPath,
      knowledgePath: this.knowledgePath,
      instructionTreePath: this.instructionTreePath,
      available,
    });
  }

  async importRepository(raw: PersonalDataImport): Promise<PersonalDataStatus> {
    const input = personalDataImportSchema.parse(raw);
    const repository = parseGitHubRepositoryUrl(input.repositoryUrl);
    this.assertImportTarget();
    const credential = this.credentialToken === undefined
      ? undefined
      : async (): Promise<RepositoryCredential | undefined> => {
          let token: string | null;
          try {
            token = await this.credentialToken!();
          } catch {
            token = null;
          }
          return token === null || token.trim().length === 0 ? undefined : { token };
        };
    const gitInput: GitRepositoryInput = {
      cloneUrl: repository.cloneUrl,
      owner: repository.owner,
      name: repository.name,
      remoteName: PERSONAL_DATA_REMOTE,
      defaultBranch: input.branch,
      targetPath: this.personalPath,
      managedRoot: dirname(this.personalPath),
      ...(credential === undefined ? {} : { credential }),
    };
    try {
      await this.gitWorkspace.clone(gitInput, {
        allowEmptyTarget: true,
        validateStagedRepository: (stagingPath) => this.validateStagedRepository(stagingPath),
      });
    } catch (error) {
      throw this.toImportError(error);
    }
    return this.getStatus();
  }

  refreshInstructionTree(): PersonalDataInstructionTreeRefreshResponse {
    if (!this.hasRequiredDirectories()) {
      throw new PersonalDataUnavailableError(
        "Personal Data repository must contain knowledge, prompts, and skills directories",
      );
    }
    assertSafePathAncestors(this.knowledgePath, "Personal Data knowledge path");
    assertSafeOutputPath(this.instructionTreePath);
    const treeOptions: TreeOptions = {
      allFiles: true,
      fullPath: true,
      gitignore: false,
      maxDepth: Number.POSITIVE_INFINITY,
      exclude: [
        /(?:^|[\\/])\.git(?:[\\/]|$)/,
        /(?:^|[\\/])node_modules(?:[\\/]|$)/,
        /(?:^|[\\/])\.loong(?:[\\/]|$)/,
        /(?:^|[\\/])\.DS_Store$/,
      ],
    };
    const prompts = this.treeRenderer(join(this.personalPath, "prompts"), treeOptions);
    const skills = this.treeRenderer(join(this.personalPath, "skills"), treeOptions);
    const content = [
      "# Instruction Tree",
      "",
      "## Prompts",
      "",
      "```text",
      prompts,
      "```",
      "",
      "## Skills",
      "",
      "```text",
      skills,
      "```",
      "",
    ].join("\n");
    atomicWrite(this.instructionTreePath, content);
    const result = {
      path: this.instructionTreePath,
      updatedAt: this.timestamp(),
    };
    return personalDataInstructionTreeRefreshResponseSchema.parse(result);
  }

  private assertImportTarget(): void {
    assertSafePathAncestors(this.personalPath, "Personal Data path");
    if (!existsSync(this.personalPath)) return;
    const info = lstatSync(this.personalPath);
    if (info.isSymbolicLink()) {
      throw new PersonalDataImportConflictError("Personal Data path must not be a symlink");
    }
    if (!info.isDirectory()) {
      throw new PersonalDataImportConflictError("Personal Data path must be a directory or not exist");
    }
    if (readdirSync(this.personalPath).length > 0) {
      throw new PersonalDataImportConflictError("Personal Data path must be empty before import");
    }
  }

  private validateStagedRepository(stagingPath: string): void {
    for (const directory of REQUIRED_DIRECTORIES) {
      const path = join(stagingPath, directory);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        throw new RepositoryOnboardingError(
          "clone_failed",
          `Personal Data repository is missing required directory: ${directory}`,
          stagingPath,
        );
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new RepositoryOnboardingError(
          "clone_failed",
          `Personal Data repository requires a real directory: ${directory}`,
          stagingPath,
        );
      }
    }
  }

  private hasRequiredDirectories(): boolean {
    try {
      if (!existsSync(this.personalPath) || !lstatSync(this.personalPath).isDirectory()) return false;
      return REQUIRED_DIRECTORIES.every((directory) => {
        const path = join(this.personalPath, directory);
        const info = lstatSync(path);
        return info.isDirectory() && !info.isSymbolicLink();
      });
    } catch {
      return false;
    }
  }

  private toImportError(error: unknown): Error {
    if (error instanceof PersonalDataImportConflictError || error instanceof PersonalDataImportError) return error;
    if (error instanceof RepositoryOnboardingError) {
      return new PersonalDataImportError(redactSecret(error.message));
    }
    return new PersonalDataImportError(redactSecret(error instanceof Error ? error.message : String(error)));
  }

  private timestamp(): string {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Personal Data clock returned an invalid Date");
    }
    return now.toISOString();
  }
}

function parseGitHubRepositoryUrl(raw: string): {
  owner: string;
  name: string;
  cloneUrl: string;
} {
  const value = raw.trim();
  let owner: string | undefined;
  let name: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/?#]+)$/i.exec(value);
  const shorthand = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(value);
  if (scp !== null) {
    owner = scp[1];
    name = scp[2]?.replace(/\.git$/i, "");
  } else if (shorthand !== null && !value.includes("://")) {
    owner = shorthand[1];
    name = shorthand[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new PersonalDataImportError("Personal Data repository URL must point to GitHub");
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.password.length > 0 ||
      (parsed.protocol === "https:" && parsed.username.length > 0) ||
      (parsed.protocol === "ssh:" && parsed.username !== "git")
    ) {
      throw new PersonalDataImportError("Personal Data repository URL must point to GitHub");
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
    if (parts.length !== 2) {
      throw new PersonalDataImportError("Personal Data repository URL must contain exactly owner/repo");
    }
    owner = parts[0];
    name = parts[1];
  }
  if (
    owner === undefined ||
    name === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  ) {
    throw new PersonalDataImportError("Personal Data repository URL contains an invalid GitHub path");
  }
  const normalizedOwner = owner.toLowerCase();
  const normalizedName = name.toLowerCase();
  return {
    owner: normalizedOwner,
    name: normalizedName,
    cloneUrl: `https://github.com/${normalizedOwner}/${normalizedName}.git`,
  };
}

function assertStrictDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new PersonalDataUnavailableError("Personal Data knowledge path must be inside the Personal Data path");
  }
}

function assertSafePathAncestors(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new PersonalDataUnavailableError(`${label} must not contain symlinks`);
      if (current === resolve(path) && !info.isDirectory()) {
        throw new PersonalDataUnavailableError(`${label} must be a directory`);
      }
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertSafeOutputPath(path: string): void {
  const output = resolve(path);
  const parent = dirname(output);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new PersonalDataUnavailableError("Instruction Tree directory must not be a symlink");
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new PersonalDataUnavailableError("Instruction Tree file must not be a symlink");
  }
}

function redactSecret(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2_000)
    .trim() || "Personal Data import failed";
}
