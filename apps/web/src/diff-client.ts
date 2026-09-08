import {
  fileContentQuerySchema,
  fileContentResponseSchema,
  localCommandResponseSchema,
  preparePullResponseSchema,
  pullRequestDetailSchema,
  pullRequestParamsSchema,
  repositoryTreeResponseSchema,
  type FileContentResponse,
  type LocalCommandResponse,
  type PreparePullResponse,
  type PullRequestDetail,
  type RepositoryTreeResponse,
} from "@loongboard/contracts";

import { request } from "./metadata-client";

type Schema<T> = { parse: (input: unknown) => T };

function pullRequestUrl(repositoryId: string, number: number): string {
  return `/api/repositories/${encodeURIComponent(repositoryId)}/pulls/${number}`;
}

async function readQuery<T>(
  url: string,
  schema: Schema<T>,
  signal?: AbortSignal,
): Promise<T> {
  return request(url, schema, { signal });
}

export function fetchPullRequestDetail(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestDetail> {
  const params = pullRequestParamsSchema.parse({ id: repositoryId, number });
  return readQuery(
    pullRequestUrl(params.id, params.number),
    pullRequestDetailSchema,
    signal,
  );
}

export function preparePullRequest(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<PreparePullResponse> {
  const params = pullRequestParamsSchema.parse({ id: repositoryId, number });
  return request(
    `${pullRequestUrl(params.id, params.number)}/prepare`,
    preparePullResponseSchema,
    { method: "POST", signal },
  );
}

export function fetchFileContent(
  repositoryId: string,
  number: number,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<FileContentResponse> {
  const params = pullRequestParamsSchema.parse({ id: repositoryId, number });
  const query = fileContentQuerySchema.parse({ path, ref });
  const search = new URLSearchParams({
    path: query.path,
    ref: query.ref,
  }).toString();
  return readQuery(
    `${pullRequestUrl(params.id, params.number)}/file?${search}`,
    fileContentResponseSchema,
    signal,
  );
}

export function fetchRepositoryTree(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<RepositoryTreeResponse> {
  const params = pullRequestParamsSchema.parse({ id: repositoryId, number });
  return readQuery(
    `${pullRequestUrl(params.id, params.number)}/tree`,
    repositoryTreeResponseSchema,
    signal,
  );
}

export function fetchLocalCommand(
  repositoryId: string,
  number: number,
  signal?: AbortSignal,
): Promise<LocalCommandResponse> {
  const params = pullRequestParamsSchema.parse({ id: repositoryId, number });
  return readQuery(
    `${pullRequestUrl(params.id, params.number)}/local-command`,
    localCommandResponseSchema,
    signal,
  );
}
