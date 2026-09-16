/** Minimal structural byte-stream types that do not force DOM streams into React Native .d.ts files. */
export interface ByteReadResult {
    readonly done: boolean;
    readonly value?: Uint8Array;
}

export interface ByteStreamReader {
    read(): Promise<ByteReadResult>;
    releaseLock(): void;
}

export interface ByteReadableStream {
    getReader(): ByteStreamReader;
}
