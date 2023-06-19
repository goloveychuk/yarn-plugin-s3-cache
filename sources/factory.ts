import {
  Hooks,
  Plugin,
  structUtils,
  Report,
  miscUtils,
  SettingsType,
  ConfigurationValueMap,
} from '@yarnpkg/core';
import { download } from './download';
import { upload } from './upload';
import { Config } from './common';
import * as fs from 'fs';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

// const compressionLevel = project.configuration.get(`compressionLevel`);
// const origFetchFromCache = opts.cache.fetchPackageFromCache.bind(
//   opts.cache
// );
// const s3cache = new S3Cache();
// opts.cache.fetchPackageFromCache = (
//   locator,
//   expectedChecksum,
//   fetchOptions
// ) => {
//   if (fetchOptions.loader) {
//     const origLoader = fetchOptions.loader;
//     fetchOptions = {
//       ...fetchOptions,
//       loader: async () => {
//         if (!expectedChecksum) {
//           return origLoader();
//         }
//         const cachePath = await s3cache.download(expectedChecksum);
//         if (cachePath) {
//           return new ZipFS(cachePath) as any;
//         }
//         const resFs = await origLoader();
//         await s3cache.upload(resFs.getRealPath(), expectedChecksum);
//         return resFs;
//         // console.log("before", locator, hash);
//         // console.log("fetchPackageFromCache caleld!!!!!!!", locator, hash, resFs);
//         // return resFs;
//       },
//     };
//   }
//   return origFetchFromCache(locator, expectedChecksum, fetchOptions);
// };
// return origFetch(opts);

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    s3CacheConfig: miscUtils.ToMapValue<{
      bucket: string;
      chunkCount: number;
      region: string | null;
    }>;
  }
}

interface Options {
  shouldFetch: boolean;
  shouldUpload: boolean;
  bucket: string;
  chunkCount: number;
  region: string | null;
}

type GetOptions = (input: ConfigurationValueMap['s3CacheConfig']) => Options;

const defaultGetOptions: GetOptions = (configInput) => {
  //@ts-ignore
  if (global.S3_GET_OPTIONS) {
    //@ts-ignore
    return global.S3_GET_OPTIONS;
  }
  return {
    region: configInput.get('region'),
    shouldFetch: process.env.S3_CACHE_SHOULD_FETCH === 'true',
    shouldUpload: process.env.S3_CACHE_SHOULD_UPLOAD === 'true',
    bucket: configInput.get('bucket'),
    chunkCount: configInput.get('chunkCount'),
  };
};

export default (getOptions: GetOptions = defaultGetOptions): Plugin<Hooks> => ({
  configuration: {
    s3CacheConfig: {
      type: SettingsType.SHAPE,
      description: 'S3 cache config',
      properties: {
        bucket: {
          default: 'yarn-s3-cache',
          description: `s3 bucket name`,
          type: SettingsType.STRING,
        },
        chunkCount: {
          description: `number of chunks, basically concurrency (one file limit is 100mbit), default 10`,
          default: 10,
          type: SettingsType.NUMBER,
        },
        region: {
          description: `aws region`,
          isNullable: true,
          default: null,
          type: SettingsType.STRING,
        },
      },
    },
  },
  hooks: {
    // afterAllInstalled: () => {
    //   console.log(`What a great install, am I right?`);
    // },
    // reduceDependency: async (dep, proj, loc, initDep, extra) => {
    //   console.log('reduceDependency caleld2!!!!!!!')
    //   dep.range = 'asd$'+dep.range;
    //   return dep
    // }
    validateProject: (project) => {
      const origFetch = project.fetchEverything.bind(project);
      project.fetchEverything = async (opts) => {
        const options = getOptions(project.configuration.get('s3CacheConfig'));

        if (!options.shouldFetch && !options.shouldUpload) {
          return origFetch(opts);
        }
        const rootWorkspace = project.getWorkspaceByCwd(project.cwd)!;
        const projectName = rootWorkspace.manifest.name;
        if (!projectName) {
          throw new Error(`Root monorepo should have name`);
        }
        // const archivesDir = opts.cache.mirrorCwd ?? opts.cache.cwd;
        const archivesDir = opts.cache.cwd; //not sure

        const config = new Config({
          bucket: options.bucket,
          chunkCount: options.chunkCount,
          s3Config: {
            credentials: defaultProvider(), // env vars used https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_credential_provider_node.html
            region: options.region || undefined, //undefined to use default resolution: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html
          },
          archivesDir,
          cacheKey: [
            structUtils.stringifyIdent(projectName),
            String(project.configuration.get(`compressionLevel`)),
          ],
        });

        if (options.shouldFetch) {
          await opts.report.startTimerPromise(
            `Downloading cache from s3`,
            async () => {
              await download(config, opts.report);
            },
          );
        }

        const result = await origFetch(opts);
        if (options.shouldUpload) {
          const filesToUpload = Array.from(opts.cache.markedFiles).filter(
            (f) => fs.existsSync(f), //filtering conditional packages
          );
          await opts.report.startTimerPromise(
            `Uploading cache to s3`,
            async () => {
              await upload(config, filesToUpload, opts.report);
            },
          );
        }
        return result;
      };
    },
  },
});
