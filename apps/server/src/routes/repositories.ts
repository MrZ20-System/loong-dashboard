import {
  listRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import {
  repositoriesResponseSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import { sendParsed } from "../route-helpers.js";

export interface RepositoryRoutesDependencies {
  database: DatabaseClient;
}

/** Repository list projection used by the repository picker and dashboard. */
export function registerRepositoryRoutes(
  app: FastifyInstance,
  dependencies: RepositoryRoutesDependencies,
): void {
  app.get("/api/repositories", async (_request, reply) => {
    const repositories = listRepositories(dependencies.database).map((repository) => ({
      id: repository.id,
      key: repository.key,
      displayName: repository.displayName,
      githubOwner: repository.githubOwner,
      githubName: repository.githubName,
      localPath: repository.localPath,
      remoteName: repository.remoteName,
      defaultBranch: repository.defaultBranch,
      worktreeSlots: repository.worktreeSlots,
      enabled: repository.enabled,
      pullRequestCount: repository.pullRequestCount ?? 0,
      mergedPullRequestCount: repository.mergedPullRequestCount ?? 0,
      issueCount: repository.issueCount ?? 0,
    }));
    return sendParsed(reply, 200, repositoriesResponseSchema, {
      items: repositories,
    });
  });
}
