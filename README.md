[![NPM Version](https://img.shields.io/npm/v/yarn-plugin-s3-cache.svg?style=flat)](https://www.npmjs.com/package/yarn-plugin-s3-cache)
[![NPM License](https://img.shields.io/npm/l/all-contributors.svg?style=flat)](https://github.com/goloveychuk/yarn-plugin-s3-cache/blob/master/LICENSE)

Yarn plugin which accelerates which uses s3 bucket to cache zip archives.

Works great for fast ci machines, which have fast s3 networking.

Also postinstalls for pnp linker are cached. 

### Install:

1) `npx yarn-plugin-s3-cache`
2) Edit config file, it should return s3 access creds. You can get it from env or import aws sdk to read profile files.
