import { Hooks, Plugin, structUtils, Report, miscUtils, SettingsType } from '@yarnpkg/core';
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
      bucket: string
      chunkCount: number
      region: string | null
    }>;
  }
}

const plugin: Plugin<Hooks> = {
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
        const shouldFetch = process.env.S3_CACHE_SHOULD_FETCH === 'true';
        const shouldUpload = process.env.S3_CACHE_SHOULD_UPLOAD === 'true';
        if (!shouldFetch && !shouldUpload) {
          return origFetch(opts);
        }
        const rootWorkspace = project.getWorkspaceByCwd(project.cwd)!;
        const projectName = rootWorkspace.manifest.name;
        if (!projectName) {
          throw new Error(`Root monorepo should have name`);
        }
        // const archivesDir = opts.cache.mirrorCwd ?? opts.cache.cwd;
        const archivesDir = opts.cache.cwd; //not sure

        const configInput = project.configuration.get('s3CacheConfig');

        const config = new Config({
          bucket: configInput.get('bucket'),
          chunkCount: configInput.get('chunkCount'),
          s3Config: {
            credentials: defaultProvider(), // env vars used https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_credential_provider_node.html
            region: configInput.get('region') || undefined, //undefined to use default resolution: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html
          },
          archivesDir,
          cacheKey: [
            structUtils.stringifyIdent(projectName),
            String(project.configuration.get(`compressionLevel`)),
          ],
        });

        if (shouldFetch) {
          await opts.report.startTimerPromise(
            `Downloading cache from s3`,
            async () => {
              await download(config, opts.report);
            },
          );
        }

        const result = await origFetch(opts);
        if (shouldUpload) {
          const filesToUpload = Array.from(opts.cache.markedFiles).filter((f) =>
            fs.existsSync(f), //filtering conditional packages
          ); 
          await opts.report.startTimerPromise(
            `Uploading cache to s3`,
            async () => {
              await upload(config, filesToUpload, opts.report);
            }
          );
        }
        return result;
      };
    },
  },
};

export default plugin;
