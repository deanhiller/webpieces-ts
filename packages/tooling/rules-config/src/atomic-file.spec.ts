import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AtomicFile } from './atomic-file';

/**
 * A separate OS PROCESS that hammers the file with reads and reports how many times it caught the file
 * mid-write. It must be a real process: within one process a synchronous write cannot be interleaved
 * with a read, so an in-process "concurrency" test would pass no matter how the writer is implemented.
 *
 * Plain JS on purpose — the reader only needs `readFileSync` + `JSON.parse`, which is exactly what the
 * guards do on their blocking path.
 */
const READER_SOURCE = `
const fs = require('fs');
const target = process.argv[2];
const stopFile = process.argv[3];
fs.writeFileSync(stopFile + '.ready', '');
let reads = 0, failures = 0, missing = 0;
while (!fs.existsSync(stopFile)) {
    try {
        const text = fs.readFileSync(target, 'utf8');
        reads++;
        const parsed = JSON.parse(text);
        // A torn file can still parse if it happens to end on a valid prefix, so check the sentinel
        // that is written LAST in the payload as well.
        if (parsed.tail !== 'END') failures++;
    } catch (err) {
        if (err && err.code === 'ENOENT') missing++;
        else failures++;
    }
}
process.stdout.write(JSON.stringify({ reads: reads, failures: failures, missing: missing }));
`;

class ReaderProcess {
    readonly child: ChildProcess;
    private output: string = '';

    constructor(child: ChildProcess) {
        this.child = child;
        child.stdout?.on('data', (chunk: Buffer): void => { this.output += chunk.toString(); });
    }

    async result(): Promise<ReaderResult> {
        await new Promise<void>((resolve: () => void): void => {
            this.child.on('exit', (): void => { resolve(); });
        });
        const parsed = JSON.parse(this.output) as { reads: number; failures: number; missing: number };
        return new ReaderResult(parsed.reads, parsed.failures, parsed.missing);
    }
}

/** Data-only (per CLAUDE.md: classes for data). */
class ReaderResult {
    readonly reads: number;
    readonly failures: number;
    readonly missing: number;

    constructor(reads: number, failures: number, missing: number) {
        this.reads = reads;
        this.failures = failures;
        this.missing = missing;
    }
}

// Big enough that a truncating write leaves a wide window for a reader to fall into. ~1.5 MB.
function payload(marker: string): object {
    const filler: string[] = [];
    for (let i = 0; i < 20000; i++) filler.push(`${marker}-entry-${String(i)}`);
    return { marker: marker, filler: filler, tail: 'END' };
}

// Module-scope fixture for the concurrency describe (kept out of the describe body so the callback
// stays within max-method-lines).
let dir: string;
let target: string;
let stopFile: string;
let readerScript: string;

// Start the reader and WAIT until it is actually looping. Without this the parent's synchronous write
// burst can finish before the child has even booted, and the test proves nothing.
async function startReader(): Promise<ReaderProcess> {
    const reader = new ReaderProcess(spawn(process.execPath, [readerScript, target, stopFile], {
        stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const readyFile = `${stopFile}.ready`;
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile) && Date.now() < deadline) {
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 5); });
    }
    expect(fs.existsSync(readyFile)).toBe(true);
    return reader;
}

// Hammer the file for a wall-clock window rather than a fixed count, so the reader gets a real chance
// to land inside a write regardless of how fast this machine is.
function writeFor(millis: number, write: (iteration: number) => void): number {
    const deadline = Date.now() + millis;
    let iterations = 0;
    while (Date.now() < deadline) {
        write(iterations);
        iterations++;
    }
    return iterations;
}

describe('AtomicFile under a genuinely concurrent reader', () => {
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')));
        target = path.join(dir, 'merged-branches.json');
        stopFile = path.join(dir, 'STOP');
        readerScript = path.join(dir, 'reader.js');
        fs.writeFileSync(readerScript, READER_SOURCE);
    });

    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    /**
     * CONTROL. Proves the harness can actually SEE a torn read — without this, a green result from the
     * test below would be worthless (it might simply never have caught the writer mid-write).
     */
    it('a plain writeFileSync IS caught torn by a concurrent reader (control)', async () => {
        const big = JSON.stringify(payload('naive'));
        fs.writeFileSync(target, big);
        const reader = await startReader();

        writeFor(2000, (): void => { fs.writeFileSync(target, big); });
        fs.writeFileSync(stopFile, '');

        const result = await reader.result();
        expect(result.reads + result.missing).toBeGreaterThan(0);
        expect(result.failures).toBeGreaterThan(0);
    });

    it('writeJsonAtomic is NEVER caught torn — same reader, same volume, zero failures', async () => {
        const atomic = new AtomicFile();
        atomic.writeJsonAtomic(target, payload('atomic-0'));
        const reader = await startReader();

        // Alternate two payloads so a reader that saw a mixture of the two would fail the sentinel or
        // the parse; identical writes could hide an overlap.
        const written = writeFor(2000, (iteration: number): void => {
            atomic.writeJsonAtomic(target, payload(`atomic-${String(iteration % 2)}`));
        });
        fs.writeFileSync(stopFile, '');
        expect(written).toBeGreaterThan(0);

        const result = await reader.result();
        expect(result.reads).toBeGreaterThan(0);
        expect(result.failures).toBe(0);
        // rename() also means the destination never disappears, so the reader never sees ENOENT either.
        expect(result.missing).toBe(0);
    });

});

describe('AtomicFile bookkeeping', () => {
    beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-io-'))); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('leaves no temp files behind, and writeIfChanged skips an identical rewrite', () => {
        const atomic = new AtomicFile();
        const file = path.join(dir, 'instruct.md');
        expect(atomic.writeIfChanged(file, 'hello\n')).toBe(true);
        const firstMtime = fs.statSync(file).mtimeMs;
        expect(atomic.writeIfChanged(file, 'hello\n')).toBe(false);
        expect(fs.statSync(file).mtimeMs).toBe(firstMtime);
        expect(atomic.writeIfChanged(file, 'changed\n')).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe('changed\n');

        const strays = fs.readdirSync(dir).filter((name: string): boolean => name.includes('.tmp-'));
        expect(strays).toEqual([]);
    });
});
