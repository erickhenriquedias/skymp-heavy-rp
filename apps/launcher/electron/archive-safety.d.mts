export class ArchiveSafetyError extends Error {
  code: string;
}

export type ArchiveEntry = {
  name: string;
  length: number;
  compressedLength: number;
  externalAttributes?: number;
};

export type ArchiveLimits = {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxPathLength?: number;
};

export function validateArchiveEntries(
  entries: ArchiveEntry[],
  limits?: ArchiveLimits,
): { normalizedNames: string[]; totalBytes: number; entryCount: number };

export function inspectArchiveForExtraction(
  zipPath: string,
  destinationRoot: string,
  limits?: ArchiveLimits,
): Promise<{ normalizedNames: string[]; totalBytes: number; entryCount: number }>;

