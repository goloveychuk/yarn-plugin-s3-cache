yarn plugin import https://github.com/goloveychuk/yarn-plugin-s3-cache/releases/latest/download/plugin-s3-cache.js


Usage:

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