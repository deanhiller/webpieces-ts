import { CONFIG_REPAIR_BOOTSTRAP_SOURCE } from './config-repair-bootstrap-source';

/** Self-contained Node probe: serialized into the POSIX shim so repairs work with missing packages. */
export class ConfigRepairProbe {
    rootFor(cwd: string): string {
        const fs = require('node:fs') as typeof import('node:fs'),
            path = require('node:path') as typeof import('node:path');
        let directory = path.resolve(cwd);
        while (!fs.existsSync(path.join(directory, 'webpieces.config.json'))) {
            const parent = path.dirname(directory);
            if (parent === directory) return cwd;
            directory = parent;
        }
        return directory;
    }

    isRepairPatch(root: string, patch: string): boolean {
        const lines = patch.trim().split('\n');
        if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return false;
        let targets = 0;
        for (const line of lines.slice(1, -1)) {
            if (!line.startsWith('*** ')) continue;
            const match = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
            if (!match || !this.isRepairFile(root, match[1])) return false;
            targets += 1;
        }
        return targets > 0;
    }

    isRepairFile(root: string, filename: string): boolean {
        const toError = this.error;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- bootstrap cannot trust package imports or malformed declarations
        try {
            const fs = require('node:fs') as typeof import('node:fs'),
                path = require('node:path') as typeof import('node:path');
            const target = this.canonical(root, path.resolve(root, filename));
            const rootFile = this.canonical(root, path.join(root, 'webpieces.config.json'));
            if (target === rootFile) return true;
            // webpieces-disable no-any-unknown -- only validated declaration strings grant repair access
            const raw: unknown = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
            if (
                !raw ||
                typeof raw !== 'object' ||
                !('rulePacks' in raw) ||
                !Array.isArray(raw.rulePacks) ||
                !raw.rulePacks.length
            )
                return false;
            const files = new Set<string>(),
                packages = new Set<string>();
            const lock = this.canonical(root, path.join(root, '.webpieces/rules.lock.json'));
            for (const declaration of raw.rulePacks) {
                if (
                    !declaration ||
                    typeof declaration !== 'object' ||
                    Array.isArray(declaration) ||
                    typeof declaration.package !== 'string' ||
                    !declaration.package ||
                    typeof declaration.config !== 'string' ||
                    !declaration.config.endsWith('.json') ||
                    path.isAbsolute(declaration.config) ||
                    Object.keys(declaration).some(
                        (key: string) => !['package', 'config'].includes(key),
                    )
                )
                    return false;
                const file = this.canonical(root, path.join(root, declaration.config));
                if (
                    file === rootFile ||
                    file === lock ||
                    files.has(file) ||
                    packages.has(declaration.package)
                )
                    return false;
                files.add(file);
                packages.add(declaration.package);
            }
            files.add(lock);
            files.add(
                this.canonical(root, path.join(root, '.webpieces/instruct-ai/rules-catalog.md')),
            );
            return files.has(target);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    private canonical(root: string, filename: string): string {
        const fs = require('node:fs') as typeof import('node:fs'),
            path = require('node:path') as typeof import('node:path');
        const pending: string[] = [];
        let ancestor = filename;
        while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
            pending.unshift(path.basename(ancestor));
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw new Error('Cannot resolve config repair path.');
            ancestor = parent;
        }
        const canonical = path.resolve(fs.realpathSync(ancestor), ...pending),
            relative = path.relative(fs.realpathSync(root), canonical);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw new Error('Config repair path escapes the repository.');
        return canonical;
    }

    // webpieces-disable no-any-unknown -- the bootstrap adapter must remain self-contained when node_modules is corrupt
    private error(err: unknown): Error {
        return err instanceof Error ? err : new Error(String(err));
    }
}

/** Emits the same compiled probe class; the shell has no separate declaration/path algorithm. */
export class ConfigRepairBootstrap {
    script(): string {
        return `${CONFIG_REPAIR_BOOTSTRAP_SOURCE} if (!new ConfigRepairProbe().isRepairFile(process.argv[1], process.argv[2])) process.exitCode = 1;`;
    }

    callScript(): string {
        return `${CONFIG_REPAIR_BOOTSTRAP_SOURCE} const probe = new ConfigRepairProbe(); const root = probe.rootFor(process.argv[1]); const payload = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); const input = payload.tool_input; const tool = payload.tool_name; const allowed = ['Write','Edit','MultiEdit'].includes(tool) && input && typeof input.file_path === 'string' ? probe.isRepairFile(root, input.file_path) : tool === 'apply_patch' && input && typeof input.command === 'string' && probe.isRepairPatch(root, input.command); if (!allowed) process.exitCode = 1;`;
    }
}
