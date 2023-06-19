import { HeadObjectCommand, S3, LifecycleRule  } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { MessageName, Report } from '@yarnpkg/core';
import * as tar from 'tar';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { Config, MetadataStorage } from './common';

const toRelative = (p: string) => {
  if (!p.startsWith('./')) {
    return './' + p;
  }
  return p;
};
interface File {
  path: string;
  size: number;
}

function splitToEqualChunks(arr: Array<File>, chunksCount: number) {
  arr.sort((a, b) => b.size - a.size);
  const chunks = new Array(chunksCount).fill(0).map(() => ({
    items: [] as Array<File>,
    size: 0,
  }));

  const getChunkIndex = () => {
    let minIndex = 0;
    let minSize = chunks[0].size;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].size < minSize) {
        minIndex = i;
        minSize = chunks[i].size;
      }
    }
    return minIndex;
  };
  for (const item of arr) {
    chunks[getChunkIndex()].items.push(item);
    chunks[getChunkIndex()].size += item.size;
  }

  return chunks.filter((chunk) => chunk.items.length > 0);
}

export async function upload(
  config: Config,
  filesToArchive: string[],
  report: Report,
) {
  const client = new S3(config.s3Config);

  const files = filesToArchive.map((p) => {
    const size = fs.statSync(p).size;

    if (!p.startsWith(config.archivesDir)) {
      throw new Error(`File ${p} is not in ${config.archivesDir}`);
    }

    return {
      path: p,
      size,
    };
  });

  const chunks = splitToEqualChunks(files, config.concurrency);

  const uploaded = new Date().toISOString();

  const totalToUpload = files.reduce(
    (acc, chunk) => acc + chunk.size * 1.02, //tar overhead
    0,
  );
  await report.startProgressPromise(
    Report.progressViaCounter(totalToUpload),
    async (progress) => {
      let uploadedSizes = new Array(chunks.length).fill(0);
      const onProgress = (chunk: number, loaded: number) => {
        uploadedSizes[chunk] = loaded;
        const totalUploaded = uploadedSizes.reduce(
          (acc, size) => acc + size,
          0,
        );
        progress.set(totalUploaded);
      };

      const allFiles = await Promise.all(
        chunks.map(async (chunk, i) => {
          const _tarStream = tar.create(
            {
              gzip: false,
              cwd: config.archivesDir,
            },
            chunk.items.map((item) =>
              toRelative(path.relative(config.archivesDir, item.path)),
            ),
          );
          const tarStream = new PassThrough();
          _tarStream.pipe(tarStream); //because tarStream is not instanceof stream.Readable

          const key = `archives/${config.getCacheKey()}/${uploaded}/${i}.tar`;

          const upload = new Upload({
            client,
            params: {
              Bucket: config.bucket,
              Body: tarStream,
              Key: key, //todo add remove  policy
            },
          });
          upload.on('httpUploadProgress', (progress) => {
            if (progress.loaded) {
              onProgress(i, progress.loaded);
            }
          });
          await upload.done();

          const head = await client.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
          );

          if (!head.ContentLength ) {
            report.reportWarning(MessageName.UNNAMED, `No ContentLength for ${key}`)
          }
          return { key, size: head.ContentLength ?? 0 };
        }),
      );
      const metadataStorage = new MetadataStorage(config);
      //   const oldMetadata = await metadataStorage.get();
      await metadataStorage.save({
        allFiles,
        uploaded,
      });
    },
  );

  //   if (oldMetadata) { //cant remove, it could be downloading now
  //     await Promise.all(
  //       oldMetadata.allKeys.map(async (key) => {
  //         await client.send(
  //           new DeleteObjectCommand({
  //             Bucket: config.bucket,
  //             Key: key,
  //           }),
  //         );
  //       }),
  //     );
  //   }
}
