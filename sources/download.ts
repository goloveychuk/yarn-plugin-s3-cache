import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { Config, DownloadWorkerData, MetadataStorage, throttle } from './common';
//@ts-expect-error
import workerCode from './download.worker.js';
import { MessageName, Report } from '@yarnpkg/core';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

export async function download(config: Config, report: Report) {
  ensureDir(config.archivesDir);

  const metadataStorage = new MetadataStorage(config);

  const metadata = await metadataStorage.get();
  if (!metadata) {
    report.reportWarning(MessageName.UNNAMED, 'No metadata, should upload first');
    return;
  }

  const totalSize = metadata.allFiles.reduce((acc, file) => acc + file.size, 0);

  await report.startProgressPromise(
    Report.progressViaCounter(totalSize),
    async (progress) => {

      let downloadedSizes = new Array(metadata.allFiles.length).fill(0);

      const setProgress = throttle(() => {
        const totalDownloaded = downloadedSizes.reduce((t, s) => t + s, 0)
        progress.set(totalDownloaded)
      }, 1000)
      
      const onProgress = (ind: number, loaded: number) => {
        downloadedSizes[ind] = loaded
        setProgress()
      }

      await Promise.all(
        metadata.allFiles.map(async (file, index) => {
          const workerData: DownloadWorkerData = {
            s3Config: config.s3Config,
            keyToDownload: file.key,
            bucket: config.bucket,
            destDir: config.archivesDir,
          };
          const worker = new Worker(workerCode, {
            workerData,
            eval: true,
          });
          await new Promise<void>((resolve, reject) => {
            worker.once('exit', (exitCode) => {
              if (exitCode === 0) {
                resolve();
              } else {
                reject(new Error(`Worker exited with code ${exitCode}`));
              }
            });
            worker.on('message', (msg) => {
              if (msg.type === 'progress') {
                onProgress(index, msg.downloadedSize);
              }
            });
            worker.once('error', reject);
          });
        }),
      );
    },
  );
}
