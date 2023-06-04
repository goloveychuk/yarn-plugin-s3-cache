import { S3, GetObjectCommand } from '@aws-sdk/client-s3';
import * as tar from 'tar';
import * as util from 'util';
import { PassThrough, pipeline } from 'stream';
import { workerData as _workerData, parentPort } from 'worker_threads';
import { DownloadWorkerData, throttle } from './common';

const pipe = util.promisify(pipeline);

const workerData = _workerData as DownloadWorkerData;

async function download() {
  const client = new S3(workerData.s3Config);

  const resp = await client.send(
    new GetObjectCommand({
      Bucket: workerData.bucket,
      Key: workerData.keyToDownload,
    }),
  );

  let downloadedSize = 0;

  const postProgress = throttle(() => {
    parentPort!.postMessage({ type: 'progress', downloadedSize });
  }, 1000)

  const progress = new PassThrough({
    transform(chunk, encoding, callback) {
      downloadedSize += chunk.length;
      postProgress();
      callback(null, chunk);
    },
  });
  await pipe(
    resp.Body as any,
    progress,
    tar.extract({ cwd: workerData.destDir }),
  );
}

function onSuccess() {}

function onError(err: Error) {
  console.error(err);
  process.exit(1);
}

download().then(onSuccess, onError);
