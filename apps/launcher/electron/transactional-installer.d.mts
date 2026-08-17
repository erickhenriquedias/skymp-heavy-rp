export class InstallTransactionError extends Error {
  code: string;
}

export type InstallTransaction = {
  gameRoot: string;
  transactionId: string;
  activeRoot: string;
  stagingRoot: string;
};

export function recoverInterruptedInstall(gameRoot: string): Promise<{
  recovered: boolean;
  transactionId?: string;
  finalized?: boolean;
}>;

export function createInstallTransaction(gameRoot: string): Promise<InstallTransaction>;

export function discardInstallTransaction(transaction: InstallTransaction): Promise<void>;

export function commitInstallTransaction(
  transaction: InstallTransaction,
  installFiles: string[],
  obsoleteFiles?: string[],
): Promise<{ transactionId: string; filesChanged: number }>;

export function rollbackLastInstall(gameRoot: string): Promise<{
  rolledBack: boolean;
  transactionId?: string;
}>;
