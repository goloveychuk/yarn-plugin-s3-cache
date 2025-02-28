import { execa } from 'execa';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getArchAndPlatform } from './utils.mjs';
import {pathToFileURL, resolve} from 'url'

const dev = process.env.DEVELOPMENT === 'true';

let targets = [
  // ['darwin', 'amd64'],
  // ['darwin', 'arm64'],
  ['linux', 'amd64'],
  ['linux', 'arm64'],
];
function getReleaseUrl() {
  const tagName = process.env.GITHUB_REF;
  if (!tagName) {
    return undefined
  }
  const tag = tagName.replace("refs/tags/", "");
  return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/releases/download/${tag}/`
}

const root = path.join(process.cwd());
const projectDir = path.join(root, 'helper');
const outputDir = path.join(root, 'bundles/@yarnpkg');


let PREFIX = getReleaseUrl();

if (!PREFIX || dev) {
    PREFIX = pathToFileURL(outputDir).href + '/'
}

const build = async (conf) => {
  const [platform, arch] = conf;
  const name = `helper-${platform}-${arch}`;
  const outFile = path.join(outputDir, `${name}`);
  await execa('go', ['build', '-ldflags', "-w -s", '-o', outFile, ], {
    cwd: projectDir,
    stdio: 'inherit',
    env: { GOOS: conf[0], GOARCH: conf[1] },
  });
  if (conf[0] === 'linux') {
    await execa('upx', [outFile])
  }
  const checksum = crypto.createHash('sha512');
  checksum.update(fs.readFileSync(outFile));
  const resFile =  new URL(name, PREFIX).href
  return [name, {checksum: checksum.digest('hex'), path: resFile}];
};


if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true });
}
fs.mkdirSync(outputDir);

if (dev) {
  const { arch, platform } = getArchAndPlatform();
  targets = [[platform, arch]];
}

const metadatas = Object.fromEntries(
  await Promise.all(targets.map((t) => build(t))),
);

// console.log(JSON.stringify(metadatas, undefined, 4));
// fs.writeFileSync(
//   path.join(outputDir, 'metadata.json'),
//   JSON.stringify(metadatas),
// );