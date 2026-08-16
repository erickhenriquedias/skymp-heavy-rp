import type { Readable } from 'node:stream';

export type StreamFactory = (filePath: string) => Readable;

export function hashFileStream(
  filePath: string,
  algorithm: string,
  streamFactory?: StreamFactory,
): Promise<string>;

export function md5File(filePath: string, streamFactory?: StreamFactory): Promise<string>;

