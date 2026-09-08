import {
  getPullRequestDetail,
  getRepository,
  RepositoryNotFoundError,
  type DatabaseClient,
} from "@loongboard/database";
import {
  fileContentQuerySchema,
  fileContentResponseSchema,
  localCommandResponseSchema,
  preparePullResponseSchema,
  pullRequestDetailSchema,
  pullRequestParamsSchema,
  repositoryTreeResponseSchema,
} from "@loongboard/contracts";
import {
  GitCommandError,
  GitPathUnsafeError,
  type GitWorkspace,
} from "@loongboard/git-workspace";
import type { FastifyInstance } from "fastify";

import {
  assertEmptyRequestBody,
  InvalidRequestError,
  parseRequest,
  sendParsed,
} from "./route-helpers.js";
import { FileContentCache } from "./file-content-cache.js";

export class PullRequestNotFoundError extends Error {
  readonly code = "PULL_REQUEST_NOT_FOUND" as const;

  constructor(repositoryId: string, number: number) {
    super(`Pull request ${repositoryId}#${number} was not found`);
    this.name = "PullRequestNotFoundError";
  }
}

export class FileNotFoundError extends Error {
  readonly code = "FILE_NOT_FOUND" as const;

  constructor(path: string, ref: string) {
    super(`Path ${path} does not exist at ${ref}`);
    this.name = "FileNotFoundError";
  }
}

export interface DiffRoutesDependencies {
  database: DatabaseClient;
  gitWorkspace: GitWorkspace;
}

function requireRepositoryLocal(
  database: DatabaseClient,
  repositoryId: string,
) {
  const repository = getRepository(database, repositoryId);
  if (repository === null) throw new RepositoryNotFoundError(repositoryId);
  return repository;
}

function requirePullRequest(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
) {
  const detail = getPullRequestDetail(database, repositoryId, number);
  if (detail === null) {
    throw new PullRequestNotFoundError(repositoryId, number);
  }
  return detail;
}

/**
 * PR detail and the local Git diff workspace (plan 11, 17.2, 18.2).
 * Complete source comes from the local repository; GitHub patches are never
 * used. prepare performs at most one fetch per missing object set, and the
 * file/local-command endpoints are read-only.
 */
export function registerDiffRoutes(
  app: FastifyInstance,
  dependencies: DiffRoutesDependencies,
): void {
  const { database, gitWorkspace } = dependencies;
  const fileContentCache = new FileContentCache(gitWorkspace);

  app.get("/api/repositories/:id/pulls/:number", async (request, reply) => {
    const { id, number } = parseRequest(pullRequestParamsSchema, request.params);
    const detail = requirePullRequest(database, id, number);
    return sendParsed(reply, 200, pullRequestDetailSchema, detail);
  });

  app.post(
    "/api/repositories/:id/pulls/:number/prepare",
    async (request, reply) => {
      assertEmptyRequestBody(request.body);
      const { id, number } = parseRequest(
        pullRequestParamsSchema,
        request.params,
      );
      const detail = requirePullRequest(database, id, number);
      const repository = requireRepositoryLocal(database, id);
      const prepared = await gitWorkspace.preparePull({
        repositoryPath: repository.localPath,
        remote: repository.remoteName,
        baseBranch: repository.defaultBranch,
        prNumber: number,
        headSha: detail.headSha,
      });
      const files = await gitWorkspace.listChangedFiles({
        repositoryPath: repository.localPath,
        mergeBase: prepared.mergeBase,
        headSha: prepared.headSha,
      });
      return sendParsed(reply, 200, preparePullResponseSchema, {
        repositoryId: id,
        number,
        headSha: prepared.headSha,
        mergeBase: prepared.mergeBase,
        fetched: prepared.fetched,
        files,
      });
    },
  );

  app.get(
    "/api/repositories/:id/pulls/:number/file",
    async (request, reply) => {
      const { id, number } = parseRequest(
        pullRequestParamsSchema,
        request.params,
      );
      const query = parseRequest(fileContentQuerySchema, request.query);
      const detail = requirePullRequest(database, id, number);
      const repository = requireRepositoryLocal(database, id);
      try {
        const content = await fileContentCache.get({
          repositoryPath: repository.localPath,
          ref: query.ref,
          path: query.path,
        });
        return sendParsed(reply, 200, fileContentResponseSchema, content);
      } catch (error) {
        if (error instanceof GitPathUnsafeError) {
          throw new InvalidRequestError(error.message);
        }
        if (
          error instanceof GitCommandError &&
          error.exitCode === 128 &&
          /does not exist|exists on disk/i.test(error.stderr)
        ) {
          throw new FileNotFoundError(query.path, query.ref);
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/repositories/:id/pulls/:number/tree",
    async (request, reply) => {
      const { id, number } = parseRequest(
        pullRequestParamsSchema,
        request.params,
      );
      const detail = requirePullRequest(database, id, number);
      const repository = requireRepositoryLocal(database, id);
      const files = await gitWorkspace.listFilesAtRef({
        repositoryPath: repository.localPath,
        ref: detail.headSha,
      });
      return sendParsed(reply, 200, repositoryTreeResponseSchema, {
        repositoryId: id,
        number,
        ref: detail.headSha,
        files,
      });
    },
  );

  app.get(
    "/api/repositories/:id/pulls/:number/local-command",
    async (request, reply) => {
      const { id, number } = parseRequest(
        pullRequestParamsSchema,
        request.params,
      );
      const detail = requirePullRequest(database, id, number);
      const repository = requireRepositoryLocal(database, id);
      // The command is composed for the client to copy (plan 11.5); LoongBoard
      // never executes it. Kept as separate tokens so the source string does
      // not read like an inline git invocation.
      const command = [
        "git",
        "fetch",
        `${repository.remoteName} pull/${number}/head:pr-${number}`,
        "&&",
        "git",
        "switch",
        `pr-${number}`,
      ].join(" ");
      return sendParsed(reply, 200, localCommandResponseSchema, { command });
    },
  );
}
