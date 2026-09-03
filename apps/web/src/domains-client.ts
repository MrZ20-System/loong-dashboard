import {
  domainDeleteResponseSchema,
  domainMutationResponseSchema,
  domainsResponseSchema,
  type DomainDeleteResponse,
  type DomainMutationResponse,
  type DomainRuleCreate,
  type DomainRuleUpdate,
  type DomainsResponse,
} from "@loongboard/contracts";

import { request } from "./metadata-client";

function domainsUrl(repositoryId: string): string {
  return `/api/repositories/${encodeURIComponent(repositoryId)}/domains`;
}

function domainUrl(repositoryId: string, domainId: string): string {
  return `${domainsUrl(repositoryId)}/${encodeURIComponent(domainId)}`;
}

export function fetchDomains(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<DomainsResponse> {
  return request(domainsUrl(repositoryId), domainsResponseSchema, { signal });
}

export function createDomainRule(
  repositoryId: string,
  body: DomainRuleCreate,
): Promise<DomainMutationResponse> {
  return request(domainsUrl(repositoryId), domainMutationResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateDomainRule(
  repositoryId: string,
  domainId: string,
  body: DomainRuleUpdate,
): Promise<DomainMutationResponse> {
  return request(domainUrl(repositoryId, domainId), domainMutationResponseSchema, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteDomainRule(
  repositoryId: string,
  domainId: string,
): Promise<DomainDeleteResponse> {
  return request(domainUrl(repositoryId, domainId), domainDeleteResponseSchema, {
    method: "DELETE",
  });
}
