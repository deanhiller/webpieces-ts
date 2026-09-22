import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevServer, LOOPBACK } from '../serve/DevServer';
import { DocsSiteCli } from '../cli/DocsSiteCli';
import { DocsSiteError } from '../DocsSiteError';
import { WpDocsSiteMain } from '../cli/WpDocsSiteMain';

const FIXTURES = path.join(__dirname, 'fixtures');
const SPEC = path.join(FIXTURES, 'mixed-dialect-openapi.json');

/** Collects what the command wrote, so the single top-level handler is asserted on its OUTPUT. */
class Captured {
    readonly lines: string[] = [];

    write(chunk: string): boolean {
        this.lines.push(chunk);
        return true;
    }

    text(): string {
        return this.lines.join('');
    }
}

/** The two things the suite needs from outside the package under test: a stream, and one GET. */
class TestIo {
    // webpieces-disable no-any-unknown -- a WritableStream stub for the one method the command calls
    streamOf(captured: Captured): NodeJS.WritableStream {
        return captured as unknown as NodeJS.WritableStream;
    }

    /** A one-request GET, because the suite has to prove the socket actually serves the folder. */
    get(url: string): Promise<string> {
        return new Promise<string>((resolve: (value: string) => void): void => {
            http.get(url, (response: http.IncomingMessage): void => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer): void => {
                    chunks.push(chunk);
                });
                response.on('end', (): void => {
                    resolve(Buffer.concat(chunks).toString('utf8'));
                });
            });
        });
    }
}

const io = new TestIo();

class Fixture {
    readonly out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-cli-'));
    readonly servers: DevServer[] = [];

    server(): DevServer {
        const server = new DevServer(this.out);
        this.servers.push(server);
        return server;
    }

    async closeAll(): Promise<void> {
        for (const server of this.servers) {
            await server.stop();
        }
    }
}

const fixture = new Fixture();

afterAll(async (): Promise<void> => {
    await fixture.closeAll();
});

describe('the wp-docs-site command', () => {
    it('refuses an unknown flag instead of falling through to "needs both flags"', () => {
        expect((): unknown => new DocsSiteCli().run(['--spce', SPEC], FIXTURES)).toThrowError(
            /unknown flag '--spce'/,
        );
    });

    it('refuses a run with no --out, naming what to run instead', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the assertion IS the handler
        try {
            new DocsSiteCli().run(['--spec', SPEC], FIXTURES);
            expect.unreachable('a run with no --out must throw');
            // webpieces-disable no-any-unknown -- the catch binding, which TypeScript types for us
        } catch (err: unknown) {
            //const error = toError(err);
            expect(err).toBeInstanceOf(DocsSiteError);
            expect((err as DocsSiteError).cure).toContain('--out');
        }
    });

    it('refuses a JSON file that is not an OpenAPI document', () => {
        const notASpec = path.join(fixture.out, 'not-a-spec.json');
        fs.writeFileSync(notASpec, '{"name":"something-else"}', 'utf8');
        expect((): unknown =>
            new DocsSiteCli().run(['--spec', notASpec, '--out', fixture.out], FIXTURES),
        ).toThrowError(/declares no "openapi" version/);
    });

    it('refuses a SWAGGER 2.0 document by name, rather than rendering it as if it were 3.x', () => {
        const swagger = path.join(fixture.out, 'swagger-2.json');
        fs.writeFileSync(swagger, '{"swagger":"2.0","definitions":{}}', 'utf8');
        expect((): unknown =>
            new DocsSiteCli().run(['--spec', swagger, '--out', fixture.out], FIXTURES),
        ).toThrowError(/Swagger 2.0 document/);
    });

    it('refuses a 4.x document rather than guessing at a dialect it has never seen', () => {
        const future = path.join(fixture.out, 'openapi-4.json');
        fs.writeFileSync(future, '{"openapi":"4.0.0"}', 'utf8');
        expect((): unknown =>
            new DocsSiteCli().run(['--spec', future, '--out', fixture.out], FIXTURES),
        ).toThrowError(/declares "4.0.0"/);
    });

    it('renders every failure through the ONE top-level handler, as exit code 1 and one message', async () => {
        const captured = new Captured();
        const code = await new WpDocsSiteMain().run(
            ['--spec', SPEC],
            FIXTURES,
            io.streamOf(captured),
        );
        expect(code).toBe(1);
        expect(captured.text()).toContain('wp-docs-site refused:');
    });

    it('prints the usage for --help and exits 0', async () => {
        const captured = new Captured();
        const code = await new WpDocsSiteMain().run(['--help'], FIXTURES, io.streamOf(captured));
        expect(code).toBe(0);
        expect(captured.text()).toContain('--spec');
    });

    it('writes a browsable directory, and the stylesheet and script beside it', () => {
        const result = new DocsSiteCli().run(['--spec', SPEC, '--out', fixture.out], FIXTURES);
        expect(result.written.some((file: string): boolean => file.endsWith('styles.css'))).toBe(
            true,
        );
        expect(result.written.some((file: string): boolean => file.endsWith('site.js'))).toBe(true);
        expect(fs.existsSync(path.join(fixture.out, 'index.html'))).toBe(true);
    });
});

describe('the localhost preview server', () => {
    it('binds the loopback address and serves a directory as its index.html', async () => {
        new DocsSiteCli().run(['--spec', SPEC, '--out', fixture.out], FIXTURES);
        const server = fixture.server();
        const port = await server.start(0);
        expect(port).toBeGreaterThan(0);
        expect(server.url()).toContain(LOOPBACK);
        const body = await io.get(`http://${LOOPBACK}:${port}/reference/plant-tree/`);
        expect(body).toContain('plantTree');
    });

    it('refuses to read anything outside the output directory', () => {
        const server = fixture.server();
        expect(server.fileFor('/../../etc/passwd')).toBeUndefined();
        expect(server.fileFor('/index.html')).toBeDefined();
    });

    it('refuses to preview a directory that was never generated', () => {
        expect((): unknown => new DevServer(path.join(fixture.out, 'nope')).start(0)).toThrowError(
            /no generated site to preview/,
        );
    });
});
