export type RepairCandidate = {
  path: string; size: number; sha256: string; downloadUrl?: string;
  required: boolean; category: string; reason: 'missing' | 'size' | 'sha256';
};
export function inspectManifestForRepair(gameRoot: string, manifest: any, options?: {
  hashFile?: (filePath: string) => Promise<string>;
}): Promise<{
  healthy: string[]; optionalMissing: string[]; repairable: RepairCandidate[];
  manual: RepairCandidate[]; unsafe: Array<{ path: string; reason: string }>;
  downloadBytes: number;
}>;
