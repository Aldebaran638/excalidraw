export type RepositoryMetadata = { version: 1; noteId: string };
export const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id);
export const readMetadata = (value: unknown): RepositoryMetadata | null => {
  const data = value as RepositoryMetadata | null;
  return data?.version === 1 && validId(data.noteId) ? data : null;
};
