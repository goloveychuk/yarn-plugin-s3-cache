import {
  Hooks,
  Plugin,
  structUtils,
  Report,
  miscUtils,
  LocatorHash,
} from '@yarnpkg/core';
import * as path from 'path'
import * as fs from 'fs'
//@ts-expect-error
import { getExecFileName } from '../utils.mjs'
import { Client } from './client';
interface File {
  s3Path: string;
  checksum: string
  outputPath: string
}
interface FetchInput {
  maxConcurrency: number;
  files: Array<File>;
}

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    s3CacheConfig: miscUtils.ToMapValue<{
      bucket: string;
      chunkCount: number;
      region: string | null;
      profile: string | null;
      filepath: string | null;
    }>;
  }
}



const CHECKSUM_REGEX = /^(?:(?<cacheKey>(?<cacheVersion>[0-9]+)(?<cacheSpec>.*))\/)?(?<hash>.*)$/;

function splitChecksumComponents(checksum: string) {
  const match = checksum.match(CHECKSUM_REGEX);
  if (!match?.groups)
    throw new Error(`Assertion failed: Expected the checksum to match the requested pattern`);

  const cacheVersion = match.groups.cacheVersion
    ? parseInt(match.groups.cacheVersion)
    : null;

  return {
    cacheKey: match.groups.cacheKey ?? null,
    cacheVersion,
    cacheSpec: match.groups.cacheSpec ?? null,
    hash: match.groups.hash,
  };
}


const plugin: Plugin<Hooks> = {
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
        const execPath = path.join(__dirname, getExecFileName())
        const userConfig = await project.loadUserConfig();
        if (!userConfig?.s3CacheConfig) {
          return origFetch(opts);
        }

        const client = new Client(execPath, {
          maxUploadConcurrency: 500,
          maxDownloadConcurrency: 500,
          ...userConfig.s3CacheConfig,
        })

        const bucket = userConfig.s3CacheConfig.bucket

        const files: FetchInput['files'] = []
        let locatorHashes = Array.from(
          new Set(
            miscUtils.sortMap(project.storedResolutions.values(), [
              (locatorHash: LocatorHash) => {
                const pkg = project.storedPackages.get(locatorHash);

                if (!pkg)
                  throw new Error(`Assertion failed: The locator should have been registered`);

                return structUtils.stringifyLocator(pkg);
              },
            ]),
          ),
        );
        let filesToNotUpload = new Set<string>()

        for (const locatorHash of locatorHashes) {
          const pkg = project.storedPackages.get(locatorHash);

          if (!pkg) {
            throw new Error(`Package not found for locator ${locatorHash}`);
          }
          const checksum = project.storedChecksums.get(locatorHash)
          if (!checksum) {
            continue
          }

          const outputFile = opts.cache.getLocatorPath(pkg, checksum);
          if (fs.existsSync(outputFile)) {
            // filesToNotUpload.add(outputFile)
            continue
          }
          const basename = path.basename(outputFile);
          files.push({
            s3Path: `s3://${bucket}/${basename}`,
            checksum: splitChecksumComponents(checksum).hash,
            outputPath: outputFile,
          })
        }

        await client.start()
        await opts.report.startTimerPromise(
          `Downloading cache from s3: ${files.length} files`,
          async () => {
            await Promise.all(files.map(async (f) => {
              const res = await client.downloadFile(f);
              if (res.result) {
                filesToNotUpload.add(f.outputPath)
              }
            }))
          }
        )
        const result = await origFetch(opts)
        const filesToUpload = Array.from(opts.cache.markedFiles).filter(
          (f) => !filesToNotUpload.has(f) && fs.existsSync(f), //filtering conditional packages
        );
        await opts.report.startTimerPromise(
          `Uploading cache to s3: ${filesToUpload.length} files`,
          async () => {
            await Promise.all(filesToUpload.map(async (f) => {
              const basename = path.basename(f);
              await client.uploadFile({
                s3Path: `s3://${bucket}/${basename}`,
                inputPath: f,
              });
            }))
          }
        );
        await client.stop()
        return result
        //   const options = getOptions(project.configuration.get('s3CacheConfig'));

        //   if (!options.shouldFetch && !options.shouldUpload) {
        //     return origFetch(opts);
        //   }
        //   const rootWorkspace = project.getWorkspaceByCwd(project.cwd)!;
        //   const projectName = rootWorkspace.manifest.name;
        //   if (!projectName) {
        //     throw new Error(`Root monorepo should have name`);
        //   }
        //   // const archivesDir = opts.cache.mirrorCwd ?? opts.cache.cwd;
        //   const archivesDir = opts.cache.cwd; //not sure


        //   const config = new Config({
        //     bucket: options.bucket,
        //     chunkCount: options.chunkCount,
        //     s3Config: {
        //       credentials: defaultProvider({
        //         profile: options.profile,
        //         filepath: options.filepath,
        //       }), // env vars used https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_credential_provider_node.html
        //       region: options.region || undefined, //undefined to use default resolution: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html
        //     },
        //     archivesDir,
        //     cacheKey: [
        //       structUtils.stringifyIdent(projectName),
        //       String(project.configuration.get(`compressionLevel`)),
        //     ],
        //   });

        //   if (options.shouldFetch) {
        //     await opts.report.startTimerPromise(
        //       `Downloading cache from s3`,
        //       async () => {
        //         await download(config, opts.report);
        //       },
        //     );
        //   }


      };
    },
  },
}

export default plugin;