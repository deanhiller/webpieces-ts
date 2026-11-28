import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { bindingScopeValues, injectable } from 'inversify';
import { InformAiError } from '@webpieces/tooling-common';

export class RecoveryFile {
    constructor(
        readonly name: string,
        readonly bytes: Buffer,
    ) {}
    hash(): string {
        return createHash('sha256').update(this.bytes).digest('hex');
    }
}

/** Explicit historical artifacts only: never import executable files, summaries or current merge state. */
@injectable(bindingScopeValues.Singleton)
export class ReviewRecoveryFiles {
    collect(source: string): RecoveryFile[] {
        const result: RecoveryFile[] = [];
        for (const name of fs.readdirSync(source)) {
            if (
                /^review-round\d+-(?:[\w-]+)(?:\.provenance)?\.json$/.test(name) ||
                [
                    'review-stage.json',
                    'pr-context.json',
                    'issue-requirements-state.json',
                    'pr-body.md',
                    'summary.json',
                ].includes(name)
            ) {
                result.push(this.read(source, name));
            } else if (['diff', 'instructions', 'stages'].includes(name)) {
                this.walk(source, name, result);
            }
        }
        return result;
    }
    private walk(source: string, relative: string, files: RecoveryFile[]): void {
        const directory = path.join(source, relative);
        if (!fs.lstatSync(directory).isDirectory())
            throw new InformAiError('Recovery source must contain real directories, not symlinks');
        for (const name of fs.readdirSync(directory)) {
            const child = path.join(relative, name);
            const stat = fs.lstatSync(path.join(source, child));
            if (stat.isDirectory()) this.walk(source, child, files);
            else files.push(this.read(source, child));
        }
    }
    private read(source: string, name: string): RecoveryFile {
        if (!fs.lstatSync(path.join(source, name)).isFile())
            throw new InformAiError(`Recovery refuses non-file: ${name}`);
        return new RecoveryFile(name, fs.readFileSync(path.join(source, name)));
    }
    /** Validate ALL conflicts before the first write. Exclusive creates make partial retry idempotent. */
    preflight(root: string, destination: string, files: RecoveryFile[]): void {
        for (const file of files) {
            const target = path.join(destination, file.name);
            if (
                fs.existsSync(target) &&
                (!fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(file.bytes))
            )
                throw new InformAiError(
                    `Recovery destination conflict: ${file.name}; nothing was overwritten`,
                );
            this.checkParents(root, destination, file.name);
        }
    }
    install(root: string, destination: string, files: RecoveryFile[]): void {
        this.preflight(root, destination, files);
        for (const file of files) {
            const target = path.join(destination, file.name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (!fs.existsSync(target)) fs.writeFileSync(target, file.bytes, { flag: 'wx' });
        }
    }
    private checkParents(root: string, destination: string, relative: string): void {
        const target = path.join(destination, relative);
        const addressed = path.relative(root, target);
        if (addressed.startsWith('..') || path.isAbsolute(addressed))
            throw new InformAiError('Recovery destination is outside its checkout');
        let directory = root;
        for (const name of addressed.split(path.sep).slice(0, -1)) {
            directory = path.join(directory, name);
            if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory())
                throw new InformAiError(
                    `Recovery refuses linked or non-directory destination: ${directory}`,
                );
        }
    }
}
