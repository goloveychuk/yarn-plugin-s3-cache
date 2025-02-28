import fetch from 'node-fetch';
import { Agent } from 'http';
import { ChildProcess, spawn } from 'child_process';
import { setInterval } from 'timers/promises'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

interface RpcPayload {
    jsonrpc: string;
    method: string;
    params: any[];
    id: number;
}

interface RpcResponse<T> {
    result: T | null;
    error: string | null;
    id: number;
}

export class Client {
    private lastId = 1
    private child?: ChildProcess
    private pipePath: string
    private agent: Agent
    constructor(private execPath: string) {
        this.pipePath = path.join(os.tmpdir(), `s3-cache-${Date.now()}.sock`);
        this.agent = new Agent({ socketPath: this.pipePath } as any);
    }

    async start() {
        const conf = {
            socketPath: this.pipePath,
            maxDownloadConcurrency: 500,
            maxUploadConcurrency: 500,
        }

        const child = spawn(this.execPath, [], { stdio: 'inherit', env: { CONFIG: JSON.stringify(conf) } })
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
        fs.unlinkSync(this.pipePath)
    }

    private async rpcCall<T extends any[], R>(method: string, ...params: T): Promise<RpcResponse<R>> {
        const id = this.lastId++;
        const payload: RpcPayload = {
            jsonrpc: "2.0",
            method,
            params,
            id,
        };
        try {
            // The URL here is arbitrary; the agent directs the connection to the Unix socket.
            const response = await fetch('http://unix/rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                agent: this.agent,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            // console.log(`Response for ${method}:`, data);
            return data as RpcResponse<R>
        } catch (error) {
            // console.error(`Error calling ${method}:`, error);
            throw error;
        }
    }

    private createRpcCall<T extends any[], R>(method: string) {
        return async (...params: T) => {
            return await this.rpcCall<T, R>(method, ...params);
        }
    }
    downloadFile = this.createRpcCall<[{ s3Path: string, outputPath: string, checksum: string }], {}>('S3Service.Download')
    uploadFile = this.createRpcCall<[{ s3Path: string, inputPath: string }], {}>('S3Service.Upload')
}

