import * as esbuild from 'esbuild';
import * as path from 'path';
import { getDynamicLibs } from '@yarnpkg/cli';
import * as fs from 'fs';
import * as os from 'os';

const pathRegExp =
  /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:@[^/]+\/)?[^/]+)\/*(.*|)$/;

const isDynamicLib = (request: string) => {
  if (getDynamicLibs().has(request)) return true;

  if (request.match(/^@yarnpkg\/plugin-/)) return true;

  return false;
};

const getNormalizedName = (name: string) => {
  const parsing = name.match(
    /^(?:@yarnpkg\/|(?:@[^/]+\/)?yarn-)(plugin-[^/]+)/,
  );
  if (parsing === null)
    throw new Error(
      `Invalid plugin name "${name}" - it should be "yarn-plugin-<something>"`,
    );

  return `@yarnpkg/${parsing[1]}`;
};

const matchAll = /()/;

const tempDir = fs.promises.mkdtemp(
  path.join(os.tmpdir(), 'esbuild-worker-plugin-'),
);

function inlineWorkerPlugin(): esbuild.Plugin {
  return {
    name: 'esbuild-plugin-inline-worker',

    setup(build) {
      build.onLoad(
        { filter: /\.worker\.(js|jsx|ts|tsx)$/ },
        async ({ path: workerPath }) => {
          let workerCode = await buildWorker(workerPath, build.initialOptions);
          return {
            contents: `
const workerCode = ${JSON.stringify(workerCode)}
export default workerCode;
`,
            loader: 'js',
          };
        },
      );
    },
  };
}


async function buildWorker(
  workerPath: string,
  extraConfig: esbuild.BuildOptions,
) {
  let scriptNameParts = path.basename(workerPath).split('.');
  scriptNameParts.pop();
  scriptNameParts.push('js');
  let scriptName = scriptNameParts.join('.');
  let bundlePath = path.resolve(await tempDir, scriptName);

  const result = await esbuild.build({
    entryPoints: [workerPath],
    bundle: true,
    outfile: bundlePath,
    format: 'cjs',
    platform: `node`,
    target: `node14`,
    minify: extraConfig.minify,
  });
  if (result.errors.length)  {
    throw new Error(
      `Failed to build worker "${workerPath}":\n` +
        result.errors.map((error) => error.text).join(`\n`),
    );
  }

  return fs.promises.readFile(bundlePath, { encoding: 'utf-8' });
}

async function bundle() {
  const basedir = process.cwd();
  const { name: rawName, main } = require(`${basedir}/package.json`);
  const name = getNormalizedName(rawName);
  const output = path.join(basedir, `bundles/${name}.js`);

  const isDev = process.env.NODE_ENV === `development`;

  const dynamicLibResolver: esbuild.Plugin = {
    name: `dynamic-lib-resolver`,
    setup(build) {
      build.onResolve({ filter: matchAll }, async (args) => {
        const dependencyNameMatch = args.path.match(pathRegExp);
        if (dependencyNameMatch === null) return undefined;

        const [, dependencyName] = dependencyNameMatch;
        if (dependencyName === name || !isDynamicLib(args.path))
          return undefined;

        return {
          path: args.path,
          external: true,
        };
      });
    },
  };

  const res = await esbuild.build({
    banner: {
      js: [
        `/* eslint-disable */`,
        `//prettier-ignore`,
        `module.exports = {`,
        `name: ${JSON.stringify(name)},`,
        `factory: function (require) {`,
      ].join(`\n`),
    },
    globalName: `plugin`,
    footer: {
      js: [`return plugin;`, `}`, `};`].join(`\n`),
    },
    entryPoints: [path.resolve(basedir, main ?? `sources/index`)],
    bundle: true,
    outfile: output,
    // Default extensions + .mjs
    resolveExtensions: [`.tsx`, `.ts`, `.jsx`, `.mjs`, `.js`, `.css`, `.json`],
    logLevel: `silent`,
    format: `iife`,
    platform: `node`,
    plugins: [dynamicLibResolver, inlineWorkerPlugin()],
    minify: !isDev,
    sourcemap: isDev ? `inline` : false,
    target: `node14`,
  });

  if (res.errors.length) {
    throw new Error(`Failed to build ${name}: ${res.errors.join(`, `)}`);
  }
}

bundle().catch((err) => {
  console.error(err);
  process.exit(1);
});
