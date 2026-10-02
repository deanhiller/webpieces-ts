import { createServer, Server, ServerResponse, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as ts from 'typescript';
import { build, Plugin, PluginBuild, OnLoadArgs, OnLoadResult } from 'esbuild';
import { chromium, Browser } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

/** Serves the actual bundled generated client and finite-request JSONL endpoint to Chromium. */
class ChromiumStreamingFixture {
    private server?: Server;
    private browser?: Browser;
    private response?: ServerResponse;
    private bundle = '';
    initialRequest = '';
    peerCancelled = false;

    async start(): Promise<string> {
        const output = await build({
            entryPoints: [
                path.resolve(
                    'packages/http/http-client-browser/src/__tests__/fixtures/BrowserStreamingFixture.ts',
                ),
            ],
            bundle: true,
            write: false,
            format: 'iife',
            globalName: 'StreamingBrowser',
            platform: 'browser',
            tsconfig: 'tsconfig.base.json',
            plugins: [this.metadataPlugin()],
        });
        this.bundle = output.outputFiles[0].text;
        this.server = createServer((request: IncomingMessage, response: ServerResponse): void =>
            this.handle(request, response),
        );
        await new Promise<void>((resolve: () => void): void => {
            this.server!.listen(0, '127.0.0.1', resolve);
        });
        this.browser = await chromium.launch({ headless: true });
        return 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    }

    async verify(): Promise<void> {
        const origin = await this.start();
        const page = await this.browser!.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error): void => {
            errors.push(error.stack ?? error.message);
        });
        await page.goto(origin);
        expect(errors).toEqual([]);
        const initial = await page.evaluate('StreamingBrowser.fixture.start()');
        expect(initial).toEqual({ session: 'accepted' });
        expect(this.initialRequest).toBe('{"room":"support"}\n');
        this.response!.write('{"text":"hel');
        this.response!.end('lo 🙂"}\n');
        expect(await page.evaluate('StreamingBrowser.fixture.finish()')).toEqual([
            { text: 'hello 🙂' },
        ]);
        await page.reload();
        this.initialRequest = '';
        await page.evaluate('StreamingBrowser.fixture.start()');
        await page.evaluate('StreamingBrowser.fixture.cancel()');
        await vi.waitFor(() => expect(this.peerCancelled).toBe(true));
    }

    async stop(): Promise<void> {
        await this.browser?.close();
        this.server?.closeAllConnections();
        if (this.server)
            await new Promise<void>((resolve: () => void): void => {
                this.server!.close(() => resolve());
            });
    }

    private handle(request: IncomingMessage, response: ServerResponse): void {
        if (request.url === '/client.js') {
            response.setHeader('Content-Type', 'application/javascript');
            response.end(this.bundle);
        } else if (request.url === '/stream/watch') {
            response.once('close', (): void => {
                if (!response.writableEnded) this.peerCancelled = true;
            });
            request.setEncoding('utf8');
            request.on('data', (chunk: string): void => {
                this.initialRequest += chunk;
            });
            request.on('end', (): void => {
                response.writeHead(200, { 'Content-Type': 'application/x-webpieces-jsonl' });
                response.write('{"session":"accepted"}\n');
                this.response = response;
            });
        } else response.end('<html><script src="/client.js"></script></html>');
    }

    private metadataPlugin(): Plugin {
        const config = ts.readConfigFile(path.resolve('tsconfig.base.json'), ts.sys.readFile);
        const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
        options.module = ts.ModuleKind.ESNext;
        options.noEmit = false;
        options.declaration = false;
        const entry = path.resolve(
            'packages/http/http-client-browser/src/__tests__/fixtures/BrowserStreamingFixture.ts',
        );
        const program = ts.createProgram([entry], options);
        const emitted = new Map<string, string>();
        program.emit(
            undefined,
            (
                file: string,
                text: string,
                _bom: boolean,
                _onError?: (message: string) => void,
                sources?: readonly ts.SourceFile[],
            ): void => {
                if (file.endsWith('.js') && sources?.[0])
                    emitted.set(path.resolve(sources[0].fileName), text);
            },
        );
        return {
            name: 'streaming-decorator-metadata',
            setup: (bundler: PluginBuild): void => {
                bundler.onLoad({ filter: /\.ts$/ }, (args: OnLoadArgs): OnLoadResult => {
                    const code = emitted.get(path.resolve(args.path));
                    if (code === undefined)
                        throw new Error('No emitted browser fixture code for ' + args.path);
                    return { contents: code, loader: 'js' };
                });
            },
        };
    }
}

describe('real Chromium response streaming', () => {
    it('uses browser Fetch through the generated proxy and resolves before streamed EOF', async () => {
        const fixture = new ChromiumStreamingFixture();
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- integration resources must close even when an assertion fails
        try {
            await fixture.verify();
        } finally {
            await fixture.stop();
        }
    }, 30_000);
});
