import { MutationCache, QueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export const notesQuery = queryOptions({ queryKey: ["notes"], queryFn: api.listNotes });

export const noteQuery = (id: string) =>
  queryOptions({
    queryKey: ["note", id],
    queryFn: () => api.getNote(id),
    // A refetch that started before an AI result was stored would bring back the old value.
    refetchOnWindowFocus: false,
  });

export const queryClient: QueryClient = new QueryClient({
  // Every failed read shows a Retry button, so a failure shows at once instead of after silent retries.
  defaultOptions: { queries: { retry: false } },
  // Every change (save, delete, AI result) can change the list, so each one refreshes it.
  mutationCache: new MutationCache({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notesQuery.queryKey }),
  }),
});
