import fetch from 'node-fetch';
import { Agent } from 'http';
import { ChildProcess, spawn } from 'child_process';
import { setInterval } from 'timers/promises'

interface RpcPayload {
    jsonrpc: string;
    method: string;
    params: any[];
    id: number;
}

export class Client {
    private lastId = 1
    private child?: ChildProcess
    private pipePath = '/tmp/s3_rpc.sock'
    constructor(private execPath: string) {

    }

    async start() {
        const child = spawn(this.execPath, [JSON.stringify({
            socketPath: this.pipePath,
            maxDownloadConcurrency: 500,
            maxUploadConcurrency: 500,
        })], { stdio: 'inherit' })
        this.child = child

        return new Promise<void>((resolve, reject) => {
            child.on('spawn', async () => {
                const startTime = Date.now()
                for await (const _ of setInterval(100)) {
                    if (startTime - Date.now() > 5000) {
                        reject(new Error('timeout'))
                    }
                    try {
                        await this.rpcCall('S3Service.Ping')
                        resolve()
                        return
                    } catch (e) {

                    }
                }
            })
            child.on('error', (err) => {
                reject(err)
            })
        })
    }
    async stop() {
        this.child?.kill()
    }

    private async rpcCall<T extends any[]>(method: string, ...params: T): Promise<any> {
        const id = this.lastId++;
        const payload: RpcPayload = {
            jsonrpc: "2.0",
            method,
            params: [{}],
            id,
        };

        // Create an HTTP agent that connects via the Unix domain socket (named pipe)
        const agent = new Agent({ socketPath: this.pipePath } as any);

        try {
            // The URL here is arbitrary; the agent directs the connection to the Unix socket.
            const response = await fetch('http://unix/rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                agent,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            // console.log(`Response for ${method}:`, data);
            return data;
        } catch (error) {
            // console.error(`Error calling ${method}:`, error);
            throw error;
        }
    }

    async downloadFile(data: { s3Path: string, outputPath: string, checksum: string }): Promise<void> {

        await this.rpcCall("S3Service.Download", data);
    }

    async uploadFile(): Promise<void> {
        const params = {
            s3Path: "s3://your-bucket/your-upload-key",
            inputPath: "/tmp/upload-file.txt",
        };

        await this.rpcCall("S3Service.Upload", params);
    }

}

