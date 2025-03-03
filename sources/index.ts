import {
  Hooks,
  Plugin,
  structUtils,
  miscUtils,
  LocatorHash,
  Locator,
  MessageName,
} from '@yarnpkg/core';

import { NodeFS, PortablePath, ppath, AliasFS } from '@yarnpkg/fslib';

import { PnpInstaller } from '@yarnpkg/plugin-pnp'
// import {PnpLooseInstaller} from '@yarnpkg/plugin-nm'
import * as path from 'path'
import * as fs from 'fs'
//@ts-expect-error
import { getExecFileNameForCurrentPlatform } from '../utils.mjs'
import { Client } from './client';
import { createHash } from 'crypto';
//@ts-expect-error
import metadata from '../bundles/@yarnpkg/metadata.json'

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

//sync with template
interface UserConfig {
  enable: boolean
  maxDownloadConcurrency?: number;
  maxUploadConcurrency?: number;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  bucket: string
  globalHash?: string[]
}

async function getHelperPath() {
  const name = getExecFileNameForCurrentPlatform()
  const execPath = path.join(__dirname, name)
  if (!fs.existsSync(execPath)) {
    throw new Error(`Helper ${execPath} not found`)
  }
  const hash = createHash('sha512').update(fs.readFileSync(execPath)).digest('hex')
  if (metadata[name].checksum !== hash) {
    throw new Error(`Checksum mismatch for ${name}`)
  }
  return execPath
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

const stopSymbol = Symbol('stopClient');

const plugin: Plugin<Hooks> = {
  linkers: [
    // CacheLinker,
  ],
  hooks: {
    // async wrapScriptExecution(executor, project, locator, scriptName, extra) {
    //   console.log(extra, scriptName, locator.name)
    //   return executor;
    // },
    // afterAllInstalled: () => {
    //   console.log(`What a great install, am I right?`);
    // },
    // reduceDependency: async (dep, proj, loc, initDep, extra) => {
    //   console.log('reduceDependency caleld2!!!!!!!')
    //   dep.range = 'asd$'+dep.range;
    //   return dep
    // }
    afterAllInstalled: async (project) => {
      if (stopSymbol in project) {
        await (project as any)[stopSymbol]();
        delete (project as any)[stopSymbol];
      }
    },
    validateProject: async (project) => {
      const origFetch = project.fetchEverything.bind(project);
      const config = miscUtils.dynamicRequire('./plugin-s3-cache.config.cjs') as {default: () => Promise<UserConfig>}
      const execPath = await getHelperPath()
      const userConfig = await config.default()
      const client = new Client(execPath, {
        maxUploadConcurrency: 500,
        maxDownloadConcurrency: 500,
        ...userConfig,
      })
      await client.start();

      (project as any)[stopSymbol] = async () => {
        await client.stop()
      }

      const bucket = userConfig.bucket

      project.fetchEverything = async (opts) => {
        const cache = opts.cache;
        const origFetchPackageFromCache = cache.fetchPackageFromCache.bind(cache);
        cache.fetchPackageFromCache = async (locator, expectedChecksum, opts) => {
          if (!expectedChecksum) {
            return origFetchPackageFromCache(locator, expectedChecksum, opts)
          }
          const filePath = cache.getLocatorPath(locator, expectedChecksum)
          if (fs.existsSync(filePath)) {
            // for reinstalls (local)
            return origFetchPackageFromCache(locator, expectedChecksum, opts)
          }

          const hash = splitChecksumComponents(expectedChecksum).hash;
          const compress = project.configuration.get(`compressionLevel`) === 0

          const s3Path = `s3://${bucket}/${hash}.zip${compress ? '' : '.gz'}`

          const res = await client.downloadFile({
            s3Path,
            checksum: hash,
            outputPath: filePath,
            decompress: compress,
            untar: false,
          });
          if (res.result?.downloaded === true) {
            opts.onHit?.()
            const aliasFs = new AliasFS(filePath, { baseFs: new NodeFS(), pathUtils: ppath });
            const releaseFs = () => {

            };
            cache.markedFiles.add(filePath);
            return [aliasFs, releaseFs, expectedChecksum];
          }
          const result = await origFetchPackageFromCache(locator, expectedChecksum, opts)
          // conditional packages are not always installed
          if (fs.existsSync(filePath)) {
            await client.uploadFile({
              s3Path,
              inputPath: filePath,
              compress,
              createTar: false
            })
          }
          return result
        }
        try {
          return await origFetch(opts)
        } finally {
          cache.fetchPackageFromCache = origFetchPackageFromCache
        }
        // const files: FetchInput['files'] = []
        // let locatorHashes = Array.from(
        //   new Set(
        //     miscUtils.sortMap(project.storedResolutions.values(), [
        //       (locatorHash: LocatorHash) => {
        //         const pkg = project.storedPackages.get(locatorHash);

        //         if (!pkg)
        //           throw new Error(`Assertion failed: The locator should have been registered`);

        //         return structUtils.stringifyLocator(pkg);
        //       },
        //     ]),
        //   ),
        // );
        // let filesToNotUpload = new Set<string>()

        // for (const locatorHash of locatorHashes) {
        //   const pkg = project.storedPackages.get(locatorHash);

        //   if (!pkg) {
        //     throw new Error(`Package not found for locator ${locatorHash}`);
        //   }
        //   const checksum = project.storedChecksums.get(locatorHash)
        //   if (!checksum) {
        //     continue
        //   }

        //   const outputFile = opts.cache.getLocatorPath(pkg, checksum);
        //   if (fs.existsSync(outputFile)) {
        //     // filesToNotUpload.add(outputFile)
        //     continue
        //   }
        //   const basename = path.basename(outputFile);
        //   files.push({
        //     s3Path: `s3://${bucket}/${basename}`,
        //     checksum: splitChecksumComponents(checksum).hash,
        //     outputPath: outputFile,
        //   })
        // }


        // const downloadProgress = Report.progressViaCounter(files.length);
        // const reportedDownloadProgress = opts.report.reportProgress(downloadProgress);
        // await opts.report.startTimerPromise(
        //   `Downloading cache from s3: ${files.length} files`,
        //   async () => {
        //     await Promise.all(files.map(async (f) => {
        //       const res = await client.downloadFile(f);
        //       downloadProgress.tick()
        //       if (res.result) {
        //         filesToNotUpload.add(f.outputPath)
        //       }
        //     }))
        //   }
        // )
        // reportedDownloadProgress.stop()

        // const result = await origFetch(opts)
        // const filesToUpload = Array.from(opts.cache.markedFiles).filter(
        //   (f) => !filesToNotUpload.has(f) && fs.existsSync(f), //filtering conditional packages
        // );

        // const uploadProgress = Report.progressViaCounter(filesToUpload.length);
        // const reportedUploadProgress = opts.report.reportProgress(uploadProgress);
        // await opts.report.startTimerPromise(
        //   `Uploading cache to s3: ${filesToUpload.length} files`,
        //   async () => {
        //     await Promise.all(filesToUpload.map(async (f) => {
        //       const basename = path.basename(f);
        //       await client.uploadFile({
        //         s3Path: `s3://${bucket}/${basename}`,
        //         inputPath: f,
        //       });
        //       uploadProgress.tick()
        //     }))
        //   }
        // );
        // reportedUploadProgress.stop()

        // await client.stop()
        // return result
        // //   const options = getOptions(project.configuration.get('s3CacheConfig'));

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

      const origLink = project.linkEverything.bind(project);
      project.linkEverything = async (opts) => {
        const globalHashGenerator = createHash(`sha512`);
        globalHashGenerator.update(process.versions.node);
        globalHashGenerator.update(process.platform);
        globalHashGenerator.update(process.arch);
        for (const hash of userConfig.globalHash ?? []) {
          globalHashGenerator.update(hash);
        }
        await project.configuration.triggerHook(hooks => {
          return hooks.globalHashGeneration;
        }, project, (data: Buffer | string) => {
          globalHashGenerator.update(`\0`);
          globalHashGenerator.update(data);
        });

        const globalHash = globalHashGenerator.digest(`hex`);
        const packageHashMap = new Map<LocatorHash, string>();

        // We'll use this function is order to compute a hash for each package
        // that exposes a build directive. If the hash changes compared to the
        // previous run, the package is rebuilt. This has the advantage of making
        // the rebuilds much more predictable than before, and to give us the tools
        // later to improve this further by explaining *why* a rebuild happened.


        const getBaseHash = (locator: Locator) => {
          let hash = packageHashMap.get(locator.locatorHash);
          if (typeof hash !== `undefined`)
            return hash;

          const pkg = project.storedPackages.get(locator.locatorHash);
          if (typeof pkg === `undefined`)
            throw new Error(`Assertion failed: The package should have been registered`);

          const builder = createHash(`sha512`);
          builder.update(locator.locatorHash);

          // To avoid the case where one dependency depends on itself somehow
          packageHashMap.set(locator.locatorHash, `<recursive>`);

          for (const descriptor of pkg.dependencies.values()) {
            const resolution = project.storedResolutions.get(descriptor.descriptorHash);
            if (typeof resolution === `undefined`)
              throw new Error(`Assertion failed: The resolution (${structUtils.prettyDescriptor(project.configuration, descriptor)}) should have been registered`);

            const dependency = project.storedPackages.get(resolution);
            if (typeof dependency === `undefined`)
              throw new Error(`Assertion failed: The package should have been registered`);

            builder.update(getBaseHash(dependency));
          }

          hash = builder.digest(`hex`);
          packageHashMap.set(locator.locatorHash, hash);

          return hash;
        };

        const getBuildHash = (locator: Locator, buildLocations: Array<PortablePath>) => {
          const builder = createHash(`sha512`);

          builder.update(globalHash);
          builder.update(getBaseHash(locator));

          for (const location of buildLocations)
            builder.update(location);

          return builder.digest(`hex`);
        };

        const installsToUpload: Array<{ s3Path: string, inputPath: PortablePath, locatorHash: LocatorHash }> = []

        // for (const cls of [PnpInstaller, ])
        const origInstall = PnpInstaller.prototype.installPackage;

        PnpInstaller.prototype.installPackage = async function (pkg, fetcher, fetchOptions) {
          const installResult = await origInstall.call(this, pkg, fetcher, fetchOptions)
          if (installResult.buildRequest && !installResult.buildRequest.skipped) {
            const buildHash = getBuildHash(pkg, [installResult.packageLocation]);
            const s3Path = `s3://${bucket}/${buildHash}.tar.gz`
            // TODO for incremental should add checks if build is already done (cached)
            const downloadRes = await client.downloadFile({
              s3Path,
              checksum: '',
              outputPath: installResult.packageLocation,
              untar: true, //useless unarchieve 
              decompress: true,
            })
            if (downloadRes.result?.downloaded === true) {
              return {
                packageLocation: installResult.packageLocation,
                buildRequest: {
                  skipped: true,
                  explain: (report) => {
                    report.reportInfoOnce(MessageName.BUILD_DISABLED, `${structUtils.prettyLocator(project.configuration, pkg)} cache from s3 cache.`)
                  }
                },
              }
            } else {
              installsToUpload.push({ s3Path, inputPath: installResult.packageLocation, locatorHash: pkg.locatorHash })
            }
          }
          return installResult
        }

        const result = await origLink(opts)
        await Promise.all(installsToUpload.map(async install => {
          if (!project.storedBuildState.get(install.locatorHash)) {
            // installation failed
            return
          }
          await client.uploadFile({
            compress: true,
            createTar: true,
            inputPath: install.inputPath,
            s3Path: install.s3Path,
          })
        }))
        return result
      }
    },
  },
}

export default plugin;