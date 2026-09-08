import { useQuery } from "@tanstack/react-query";
import { fetchDomains } from "../domains-client";
import { fetchRepositories } from "../metadata-client";

export function useRepositories() {
  return useQuery({
    queryKey: ["repositories"],
    queryFn: ({ signal }) => fetchRepositories(signal),
  });
}

export function useDomains(repositoryId: string) {
  return useQuery({
    queryKey: ["domains", repositoryId],
    enabled: repositoryId.length > 0,
    queryFn: ({ signal }) => fetchDomains(repositoryId, signal),
    refetchInterval: (query) =>
      query.state.data?.reclassification.running ? 2000 : false,
  });
}
