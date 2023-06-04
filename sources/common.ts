import { GetObjectCommand, PutObjectCommand, S3, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

interface Metadata {
  allFiles: Array<{ key: string; size: number }>;
  uploaded: string;
}

export const throttle = <T extends Function>(fn: T, ms: number): T => {
  let prevCalled = 0
  return ((...args: any[]) => {
    const now = Date.now()
    if (now - prevCalled > ms) {
        prevCalled = now
        return fn(...args)
    }
  }) as any as T;
};
export class MetadataStorage {
  constructor(private config: Config) {}
  private prefix = 'metadata';
  private getKey() {
    const key = this.prefix + '/' + this.config.getCacheKey();
    return key;
  }
  async save(metadata: Metadata) {
    const client = new S3(this.config.s3Config);
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getKey(),
        Body: JSON.stringify(metadata),
      }),
    );
  }
  async get(): Promise<Metadata | null> {
    const client = new S3(this.config.s3Config);
    const resp = await client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getKey(),
      }),
    );
    const stream = resp.Body as Readable;
    if (!stream) {
      return null;
    }
    const data = await new Promise<Buffer>((resolve, reject) => {
      // if (stream instanceof Blob) {
      //     return resolve(Buffer.from(stream as any,'binary'))
      // }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', reject);
    });
    try {
      return JSON.parse(data.toString('utf-8'));
    } catch (e) {
      console.error(e);
      return null;
    }
  }
}



export interface DownloadWorkerData {
  s3Config: S3ClientConfig;
  keyToDownload: string;
  destDir: string;
  bucket: string;
}

export class Config {
  constructor(
    private opts: {
      bucket: string;
      s3Config: S3ClientConfig
      archivesDir: string;
      chunkCount: number; //files count
      cacheKey: Array<string>;
    },
  ) {}

  get bucket() {
    return this.opts.bucket;
  }
  get s3Config(): S3ClientConfig {
    return this.opts.s3Config;
  }
  getCacheKey() {
    return this.opts.cacheKey.join('-');
  }

  get archivesDir() {
    return this.opts.archivesDir;
  }
  get concurrency() {
    return this.opts.chunkCount;
  }
}
