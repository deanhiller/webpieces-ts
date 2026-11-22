import { CONFIG_REPAIR_BOOTSTRAP_SOURCE } from './config-repair-bootstrap-source';

/**
 * Self-contained Node probe: serialized into the POSIX shim so recovery edits work with missing packages.
 *
 * A REPAIR FILE is one a config-repair deny can tell the agent to edit, so it is permitted while the
 * config is invalid: the root `webpieces.config.json`, `.gitignore`, everything under `.webpieces-config/`,
 * and any owner file `rulePacks` declares elsewhere. Nothing that resolves outside the repository counts.
 *
 * A RECOVERY MANIFEST is the `package.json` / `pnpm-workspace.yaml` at the ROOT of a governed tree (a
 * `webpieces.config.json` sits beside it) — the only two files a version pin or a `patchedDependencies`
 * registration lives in. Every OTHER `package.json` in the repo is ordinary code and is NOT one.
 *
 * THE ONE EDIT ESCAPE (issue #1448). Every L0 deny promises that an edit of webpieces.config.json,
 * pnpm-workspace.yaml or package.json is still allowed. `recoveryVerdict()` is the single predicate
 * behind that promise, for EVERY edit-tool spelling: Claude's Write/Edit/MultiEdit (`file_path`) and
 * Codex's `apply_patch` (`command` holds the patch; the name may arrive namespace-qualified, e.g.
 * `functions.apply_patch`). The sh half of L0 runs this compiled class through `node -e` and the JS half
 * calls it directly, so the two halves cannot answer differently. It used to be answered three ways — a
 * `file_path` scrape in sh, a config-only patch check here, and a `file_path`-only JS predicate — and a
 * Codex rollback of `pnpm-workspace.yaml` matched none of them.
 *
 * ATOMIC: a patch is permitted only when EVERY path it touches is permitted. A Delete is never a
 * recovery edit. A Move is judged on BOTH its source and its destination. A raw path carrying a `..`
 * segment is refused outright (a recovery edit never needs one), and a symlink that resolves outside the
 * repository is refused by `canonical()`.
 */
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

    /**
     * `functions.apply_patch`, `tools.apply_patch`, `codex:apply_patch` → `apply_patch`. Only the Codex
     * edit tool is canonicalized: every other name is returned untouched, so this can never turn an
     * unknown tool into one L0 trusts.
     */
    canonicalTool(toolName: string): string {
        return /^(?:[A-Za-z0-9_-]+[.:/])+apply_patch$/.test(toolName) ? 'apply_patch' : toolName;
    }

    /**
     * The one question both L0 halves ask about an edit. Returns:
     *   - `['not-an-edit']`            → not an edit tool; L0 has no edit-escape opinion.
     *   - `['config']` / `['manifest']` → every touched path is permitted (`manifest` when at least one
     *                                     is a root manifest — the audit label).
     *   - `['refused', ...lines]`       → an edit that is NOT permitted, one line per offending path.
     */
    recoveryVerdict(cwd: string, toolName: string, filePath: string, command: string): string[] {
        const tool = this.canonicalTool(toolName);
        let targets: string[][];
        if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
            if (filePath === '') return ['refused', 'the edit names no file_path'];
            targets = [['Edit', filePath]];
        } else if (tool === 'apply_patch') {
            const parsed = this.patchTargets(command);
            if (typeof parsed === 'string') return ['refused', parsed];
            targets = parsed;
        } else {
            return ['not-an-edit'];
        }
        const refusals: string[] = [];
        let manifest = false;
        for (const target of targets) {
            const op = target[0];
            const raw = target[1];
            const kind = this.targetKind(cwd, op, raw);
            if (kind === 'manifest') manifest = true;
            else if (kind !== 'config') refusals.push(`${op} ${raw}: ${kind}`);
        }
        if (refusals.length > 0) return ['refused', ...refusals];
        return [manifest ? 'manifest' : 'config'];
    }

    /**
     * Every `[op, rawPath]` an `apply_patch` envelope touches — Add, Update, Delete, and BOTH sides of a
     * Move — or a string saying why the envelope could not be read (fail closed: an envelope this does
     * not understand is never partially judged).
     */
    patchTargets(patch: string): string[][] | string {
        const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
        if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch')
            return 'the patch has no *** Begin Patch / *** End Patch envelope';
        const targets: string[][] = [];
        for (const line of lines.slice(1, -1)) {
            if (!line.startsWith('*** ')) continue;
            const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* (Move) to: (.+)$/.exec(line);
            if (match) {
                targets.push([match[1], match[2].trim()]);
                continue;
            }
            if (line.trim() === '*** End of File') continue;
            return `unrecognised patch directive ${line.trim()}`;
        }
        return targets.length > 0 ? targets : 'the patch names no file';
    }

    /** `config`, `manifest`, or the reason this one path is not a recovery target. */
    targetKind(cwd: string, op: string, raw: string): string {
        const path = require('node:path') as typeof import('node:path');
        if (op === 'Delete') return 'a Delete is never a recovery edit';
        if (raw === '' || raw.includes('\0')) return 'an empty or malformed path';
        if (raw.split(/[\\/]/).includes('..')) return 'a .. path segment is refused - name the file directly';
        const fs = require('node:fs') as typeof import('node:fs');
        const absolute = path.resolve(cwd, raw);
        // The governed tree the FILE sits in (main clone or any worktree); with none above it, the
        // session's own tree — so a path outside every governed tree is judged against, and contained
        // by, the repository the call came from.
        const own = this.rootFor(path.dirname(absolute));
        const root = fs.existsSync(path.join(own, 'webpieces.config.json')) ? own : this.rootFor(cwd);
        if (this.isRepairFile(root, absolute)) return 'config';
        if (this.isRecoveryManifest(root, absolute)) return 'manifest';
        return 'not webpieces.config.json, a .webpieces-config/ file, or the package.json / pnpm-workspace.yaml at a governed tree root';
    }

    /** The root `package.json` / `pnpm-workspace.yaml` of a governed tree, resolved inside the repository. */
    isRecoveryManifest(root: string, filename: string): boolean {
        const toError = this.error;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- bootstrap cannot trust package imports; an unresolvable path is simply not a manifest
        try {
            const fs = require('node:fs') as typeof import('node:fs'),
                path = require('node:path') as typeof import('node:path');
            const target = this.canonical(root, path.resolve(root, filename));
            if (!['package.json', 'pnpm-workspace.yaml'].includes(path.basename(target))) return false;
            return fs.existsSync(path.join(path.dirname(target), 'webpieces.config.json'));
        // webpieces-disable catch-must-propagate -- a path that escapes the repository IS the refusal verdict; the error carries nothing a caller could act on
        // webpieces-disable no-any-unknown -- a path that escapes the repository throws from canonical()
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    isRepairFile(root: string, filename: string): boolean {
        const toError = this.error;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- bootstrap cannot trust package imports or malformed declarations
        try {
            const fs = require('node:fs') as typeof import('node:fs'),
                path = require('node:path') as typeof import('node:path');
            const target = this.canonical(root, path.resolve(root, filename));
            const rootFile = this.canonical(root, path.join(root, 'webpieces.config.json'));
            if (target === rootFile || target === this.canonical(root, path.join(root, '.gitignore'))) return true;
            const policy = path.relative(this.canonical(root, path.join(root, '.webpieces-config')), target);
            if (policy !== '' && !policy.startsWith('..') && !path.isAbsolute(policy)) return true;
            // webpieces-disable no-any-unknown -- only validated declaration strings grant repair access
            const raw: unknown = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
            if (!raw || typeof raw !== 'object' || !('rulePacks' in raw) || !Array.isArray(raw.rulePacks))
                return false;
            for (const declaration of raw.rulePacks) {
                if (
                    declaration &&
                    typeof declaration === 'object' &&
                    typeof declaration.config === 'string' &&
                    declaration.config.endsWith('.json') &&
                    !path.isAbsolute(declaration.config) &&
                    this.canonical(root, path.join(root, declaration.config)) === target
                )
                    return true;
            }
            return false;
        // webpieces-disable catch-must-propagate -- an escaping path or malformed declaration IS the refusal verdict; the error carries nothing a caller could act on
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

/**
 * Emits the same compiled probe class; the shell has no separate declaration/path algorithm.
 *
 * `callScript()` is the shim's ONE edit-escape call. Its exit code is the protocol with the sh half:
 *   0 → permitted; stdout is `config` or `manifest` (the audit label).
 *   1 → not an edit tool (or unreadable stdin); the shim keeps going down its allowlist.
 *   3 → an edit that is NOT permitted; stdout is one line per offending path, for the deny.
 */
export class ConfigRepairBootstrap {
    script(): string {
        return `${CONFIG_REPAIR_BOOTSTRAP_SOURCE} if (!new ConfigRepairProbe().isRepairFile(process.argv[1], process.argv[2])) process.exitCode = 1;`;
    }

    callScript(): string {
        return `${CONFIG_REPAIR_BOOTSTRAP_SOURCE} const payload = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); const input = payload.tool_input || {}; const verdict = new ConfigRepairProbe().recoveryVerdict(typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.argv[1], String(payload.tool_name || ''), typeof input.file_path === 'string' ? input.file_path : '', typeof input.command === 'string' ? input.command : ''); if (verdict[0] === 'not-an-edit') process.exitCode = 1; else if (verdict[0] === 'refused') { process.stdout.write(verdict.slice(1).join('\\n')); process.exitCode = 3; } else process.stdout.write(verdict[0]);`;
    }
}
