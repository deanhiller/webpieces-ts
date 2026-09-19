import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpecTempDirs, specTempDirs } from './spec-temp-dirs';

describe('SpecTempDirs', () => {
    it('creates a directory under os.tmpdir() carrying the prefix', () => {
        const dirs = new SpecTempDirs();
        const dir = dirs.make('wp-sdt-');

        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.statSync(dir).isDirectory()).toBe(true);
        expect(path.basename(dir).startsWith('wp-sdt-')).toBe(true);
        expect(fs.realpathSync(path.dirname(dir))).toBe(fs.realpathSync(os.tmpdir()));

        dirs.reapAll();
    });

    it('reapAll removes every directory it created, contents and all', () => {
        const dirs = new SpecTempDirs();
        const first = dirs.make('wp-sdt-');
        const second = dirs.make('wp-sdt-');
        fs.writeFileSync(path.join(first, 'a.txt'), 'x');
        fs.mkdirSync(path.join(second, 'nested', 'deeper'), { recursive: true });

        dirs.reapAll();

        expect(fs.existsSync(first)).toBe(false);
        expect(fs.existsSync(second)).toBe(false);
    });

    it('reapAll is idempotent and never throws when a directory is already gone', () => {
        const dirs = new SpecTempDirs();
        const dir = dirs.make('wp-sdt-');
        fs.rmSync(dir, { recursive: true, force: true });

        expect((): void => dirs.reapAll()).not.toThrow();
        expect((): void => dirs.reapAll()).not.toThrow();
    });

    // The reason `makeReal` exists at all: on macOS `/var` is a symlink to `/private/var`, so a fixture
    // path and the path the code under test computes are two strings for one directory.
    it('makeReal returns a path with symlinks resolved', () => {
        const dirs = new SpecTempDirs();
        const real = dirs.makeReal('wp-sdt-');

        expect(real).toBe(fs.realpathSync(real));

        dirs.reapAll();
    });

    it('registers exactly one exit reaper however many directories are made', () => {
        const dirs = new SpecTempDirs();
        const before = process.listenerCount('exit');
        dirs.make('wp-sdt-');
        dirs.make('wp-sdt-');
        dirs.make('wp-sdt-');

        expect(process.listenerCount('exit')).toBe(before + 1);

        dirs.reapAll();
        process.removeAllListeners('exit');
    });

    it('exports a shared instance, because a private one gets its own unreaped list', () => {
        expect(specTempDirs).toBeInstanceOf(SpecTempDirs);
    });
});
