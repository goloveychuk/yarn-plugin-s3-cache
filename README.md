It's optimized for ci workflow, for big project on machines with fast s3 networking.
Archives are uploaded in tar chunks, which is waste of space because of dublicates, but decreases download time.
For 2gb pnp cache and c5.9xlarge instance, yarn fetch phase is <6s.

Usage:
0) yarn plugin import https://github.com/goloveychuk/yarn-plugin-s3-cache/releases/latest/download/plugin-s3-cache.js
1) set `process.env.S3_CACHE_SHOULD_FETCH='true'` or/and `process.env.S3_CACHE_SHOULD_UPLOAD='true'` when needed.

2) in `.yarnrc.yml`:
```yaml
s3CacheConfig:
  bucket: "yarn-s3-cache" # default
  chunkCount: 10 # default
  region: "us-east-1" # default is null, which enables default resolution
```

How credentials are resolved: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_credential_provider_node.html

How region is resolved, if not provided: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html