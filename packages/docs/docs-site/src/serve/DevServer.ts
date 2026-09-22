import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { DocsSiteError } from '../DocsSiteError';

/** The only interface this server ever binds. It is not configurable, on purpose. */
export const LOOPBACK = '127.0.0.1';

/** Extension to content type. Four entries, because a generated site holds four kinds of file. */
const CONTENT_TYPES = new Map<string, string>([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
]);

/**
 * A LOCALHOST-ONLY static preview of a generated site — what `wp-docs-site --serve` runs.
 *
 * ## It is a preview, and it is not a host
 *
 * It binds {@link LOOPBACK} and nothing else, so it is not reachable from another machine. It is not
 * hardened and it is not authenticated: there is no logging, no rate limiting, no TLS and no access
 * control, and nothing here should be read as a claim that adding an address would make it safe to
 * expose. Hosting a generated site is explicitly out of this package's scope (#985) — the output is
 * a folder, and a real static host serves it.
 *
 * The one security property it DOES enforce is that a request cannot escape the output directory:
 * the resolved path is checked against the root, so `../../etc/passwd` is a 404 rather than a read.
 * That is not hardening, it is the minimum for a process that opens a socket at all.
 */
export class DevServer {
    private server: http.Server | undefined;

    constructor(private readonly root: string) {}

    /** Binds and resolves with the port actually listening. `0` asks the OS for a free one. */
    start(port: number): Promise<number> {
        if (!fs.existsSync(this.root)) {
            throw new DocsSiteError(
                'there is no generated site to preview',
                this.root,
                'Run wp-docs-site --spec <document> --out <dir> first, then --serve the same --out.',
            );
        }
        const server = http.createServer(
            (request: http.IncomingMessage, response: http.ServerResponse): void => {
                this.handle(request, response);
            },
        );
        this.server = server;
        return new Promise<number>((resolve: (value: number) => void): void => {
            server.listen(port, LOOPBACK, (): void => {
                resolve(this.port());
            });
        });
    }

    /** The bound port, or 0 when nothing is listening. */
    port(): number {
        const address = this.server?.address();
        if (address === undefined || address === null || typeof address === 'string') {
            return 0;
        }
        return address.port;
    }

    /** The url a human opens. */
    url(): string {
        return `http://${LOOPBACK}:${this.port()}/`;
    }

    stop(): Promise<void> {
        const server = this.server;
        if (server === undefined) {
            return Promise.resolve();
        }
        this.server = undefined;
        return new Promise<void>((resolve: () => void): void => {
            server.close((): void => {
                resolve();
            });
        });
    }

    private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
        const file = this.fileFor(request.url ?? '/');
        if (file === undefined) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('not found');
            return;
        }
        const type = CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(fs.readFileSync(file));
    }

    /**
     * The file a request maps to, or `undefined` for anything outside the root or not there.
     * A directory maps to its `index.html`, which is what makes `/reference/fetch-orders/` work.
     */
    fileFor(requestUrl: string): string | undefined {
        const withoutQuery = requestUrl.split('?')[0] ?? '/';
        const decoded = decodeURIComponent(withoutQuery);
        const resolvedRoot = path.resolve(this.root);
        const target = path.resolve(resolvedRoot, `.${decoded}`);
        if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
            return undefined;
        }
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
            const index = path.join(target, 'index.html');
            return fs.existsSync(index) ? index : undefined;
        }
        return fs.existsSync(target) ? target : undefined;
    }
}
