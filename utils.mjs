import os from 'os';

const archMap = {
  x64: 'amd64',
};

export function getArchAndPlatform() {
  let arch = os.arch();
  const platform = os.platform();
  if (archMap[arch]) {
    arch = archMap[arch];
  }
  return { arch, platform };
}

export function getExecFileName({ arch, platform }) {
  return `plugin-s3-cache.helper-${platform}-${arch}`;
}

export function getExecFileNameForCurrentPlatform() {
  return getExecFileName(getArchAndPlatform())
}