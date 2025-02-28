import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';

import * as iam from '@aws-cdk/aws-iam';

export class PnpCacheStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'pnp-cache-poc', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ enabled: true, expiration: cdk.Duration.days(5) }],
    });

    const user = new iam.User(this, 'pnpCacheAuthedUser', {});

    bucket.grantReadWrite(user);

    const accessKey = new iam.CfnAccessKey(this, 'myAccessKey', {
      userName: user.userName,
    });

    new cdk.CfnOutput(this, 'bucket', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'accessKeyId', { value: accessKey.ref });
    new cdk.CfnOutput(this, 'secretAccessKey', {
      value: accessKey.attrSecretAccessKey,
    });

  }
}
