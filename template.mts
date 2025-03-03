interface UserConfig {
    maxDownloadConcurrency?: number;
    maxUploadConcurrency?: number;
    enable: boolean
    awsRegion: string;
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
    bucket: string
    globalHash?: string[]
}

export default async(): Promise<UserConfig> => {

    return {
        enable: true,
        bucket: 'my-bucket',
        awsRegion: 'us-east-1', 

        awsAccessKeyId: '',
        awsSecretAccessKey: '',
    }
}