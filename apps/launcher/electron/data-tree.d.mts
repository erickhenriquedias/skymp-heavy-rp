export function inspectDataTree(dataPath: string): { files: string[]; links: string[] };
export function findUnexpectedDataFiles(files: string[], knownPaths: string[], ignoredPaths?: string[]): string[];
