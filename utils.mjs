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

export function getExecFileName() {
  const { arch, platform } = getArchAndPlatform();
  return `helper-${platform}-${arch}`;
}