import {
  Hooks,
  Plugin,
  structUtils,
  Report,
  miscUtils,
  SettingsType,
  ConfigurationValueMap,
  LocatorHash,
} from '@yarnpkg/core';
import * as path from 'path'
import {spawnSync} from 'child_process'
import {Readable} from 'stream'
//@ts-expect-error
import {getExecFileName} from '../utils.mjs'
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

interface Options {
  shouldFetch: boolean;
  shouldUpload: boolean;
  bucket: string;
  chunkCount: number;
  profile: string | undefined;
  filepath: string | undefined;
  region: string | null;
}

type GetOptions = (input: ConfigurationValueMap['s3CacheConfig']) => Options;

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


const defaultGetOptions: GetOptions = (configInput) => {
  //@ts-expect-error
  if (typeof GET_S3_CACHE_OPTIONS === 'function') {
    //@ts-expect-error
    return GET_S3_CACHE_OPTIONS(configInput);
  }
  return {
    region: configInput.get('region'),
    profile: configInput.get('profile'),
    shouldFetch: process.env.S3_CACHE_SHOULD_FETCH === 'true',
    shouldUpload: process.env.S3_CACHE_SHOULD_UPLOAD === 'true',
    bucket: configInput.get('bucket'),
    chunkCount: configInput.get('chunkCount'),
    filepath: configInput.get('filepath'),
  };
};

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
        profile: {
          description: `aws profile`,
          isNullable: true,
          default: null,
          type: SettingsType.STRING,
        },
        filepath: {
          description: `aws creds file path`,
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
          const basename = path.basename(outputFile);
          files.push({
            s3Path: `s3://fdsfsadfksakjdfjklasdjklfsajkldsfsd/${basename}`,
            checksum: splitChecksumComponents(checksum).hash,
            outputPath: opts.cache.getLocatorPath(pkg, checksum),
          })
        }

        const execPath = path.join(__dirname, getExecFileName())

        const client = new Client(execPath)
        await  client.start()

        let pr = []
        for (const f of files) {
          pr.push(client.downloadFile(f))
        }
        await Promise.all(pr)


        await origFetch(opts)
        await client.stop()
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

        //   const result = await origFetch(opts);
        //   if (options.shouldUpload) {
        //     const filesToUpload = Array.from(opts.cache.markedFiles).filter(
        //       (f) => fs.existsSync(f), //filtering conditional packages
        //     );
        //     await opts.report.startTimerPromise(
        //       `Uploading cache to s3`,
        //       async () => {
        //         await upload(config, filesToUpload, opts.report);
        //       },
        //     );
        //   }
        //   return result;
      };
    },
  },
}

export default plugin;