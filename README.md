It's optimized for ci workflow, for big project on machines with fast s3 networking.
Archives are uploaded in tar chunks, which is waste of space because of dublicates, but decreases download time.
For 2gb pnp cache and c5.9xlarge instance, yarn fetch phase is <6s.

Usage:
0) yarn plugin import https://github.com/goloveychuk/yarn-plugin-s3-cache/releases/latest/download/plugin-s3-cache.js
1) set `process.env.S3_CACHE_SHOULD_FETCH='true'` or/and `process.env.S3_CACHE_SHOULD_UPLOAD='true'` when needed.

2) in `.yarnrc.yml`:
```yaml
s3CacheConfig:
  bucket: "yarn-s3-cache" # optional, default
  chunkCount: 10 # optional
  region: "us-east-1" # default is null, which enables default resolution
  filepath: "/aws/creds" # optional
  profile: "default" # optional
```

How credentials are resolved: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_credential_provider_node.html

How region is resolved, if not provided: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html

## Programmic usage: 

```js

const origPlugin = require("./plugin-s3-cache.js");

const customGetOptions = (opts) => {
  const isCI = require("is-ci");

  let shouldFetch = false;
  let shouldUpload = false;

  if (isCI) {
    const { getBuildInfo } = require("ci-build-info");
    const buildInfo = getBuildInfo();
    const isMaster = ["refs/heads/master", "master"].includes(
      buildInfo.v2.vcs.branch
    );
    shouldFetch = !isMaster;
    shouldUpload = isMaster;
  }

  return {
    shouldFetch,
    shouldUpload,
    chunkCount: 10,
    region: "us-east-1",
    bucket: "yarn-s3-cache",
    profile: "automation-aws",
  };
};

module.exports = {
  ...origPlugin,
  factory: (require) => {
    return origPlugin.factory(require, customGetOptions);
  },
};

```