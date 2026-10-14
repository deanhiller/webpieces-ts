import * as fs from 'node:fs';
import * as path from 'node:path';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

export const POLICY_DIR = '.webpieces-config';
import { WEBPIECES_TMP_DIR } from './state-path-constants';
// The state directory's name in 0.4.911–0.4.914 only. Never written to; a migration renames it back to
// WEBPIECES_TMP_DIR when that name is free, and otherwise leaves it inert and ignored.
const RETIRED_STATE_DIR = '.webpieces-logs';
const ROOT_CONFIG = 'webpieces.config.json';
export const MIGRATE_DIRS_COMMAND = 'pnpm wp-migrate-dirs';
const LOCK_FILE = 'rules.lock.json';
const CATALOG_FILE = 'instruct-ai/rules-catalog.md';
const RULES_DIR = 'rules';

class LayoutDeclaration {
    readonly package: string;
    constructor(
        packageName: string,
        public config: string,
    ) {
        this.package = packageName;
    }
}

class LayoutMove {
    constructor(
        readonly source: string,
        readonly target: string,
    ) {}
}

/**
 * Committed policy lives in POLICY_DIR; WEBPIECES_TMP_DIR (`.webpieces/`) is the gitignored local state.
 *
 * Releases up to 0.4.910 kept the policy files INSIDE `.webpieces/`, beside the state. The migration
 * moves exactly those policy files — a short, known list of regular files — and never walks the rest of
 * `.webpieces/`. That directory holds `trash/` (pnpm symlink farms swept out of deleted projects), logs
 * and in-flight merges; walking it is what made 0.4.914's migration refuse on a trash symlink and lock
 * every tool call in a client repo (#1254). State is never moved, so it can never fail the upgrade.
 */
export class RepositoryLayout {
    /** Refuses only when committed policy is still beside the state; the state directory itself is the current layout. */
    assertCurrent(root: string): void {
        const leftovers = this.policyLeftovers(root);
        if (leftovers.length > 0)
            throw new InformAiError(
                `Committed policy is still in ${WEBPIECES_TMP_DIR}/: ${leftovers.join(', ')}. Run ${MIGRATE_DIRS_COMMAND} to move only those files into ${POLICY_DIR}/, then stage and commit the policy migration.`,
            );
    }

    assertPolicyPath(relative: string): void {
        const normalized = relative.replace(/\\/g, '/');
        if (
            [WEBPIECES_TMP_DIR, RETIRED_STATE_DIR].some(
                (dir) => normalized === dir || normalized.startsWith(`${dir}/`),
            )
        )
            throw new InformAiError(
                `Rule policy cannot live in ${relative}. Run ${MIGRATE_DIRS_COMMAND}; committed policy belongs in ${POLICY_DIR}/, never runtime state.`,
            );
    }

    migrate(root: string): readonly string[] {
        const filename = path.join(root, ROOT_CONFIG);
        if (!fs.existsSync(filename)) return [];
        const document = this.readDocument(filename);
        const moves: LayoutMove[] = [];
        const declarations = this.declarations(document, root, moves);
        this.planPolicy(root, moves);
        this.assertInside(root, filename);
        this.assertInside(root, path.join(root, '.gitignore'));
        this.checkPlan(root, moves);
        for (const move of moves) this.move(move);
        const changed = moves.map((move) => path.relative(root, move.target));
        if (declarations.size > 0) {
            for (const entry of this.entries(document))
                entry.config = declarations.get(entry.config) ?? entry.config;
            this.write(filename, JSON.stringify(document, null, 2) + '\n', changed, root);
        }
        for (const emptied of [RULES_DIR, path.dirname(CATALOG_FILE)])
            this.removeEmpty(path.join(root, WEBPIECES_TMP_DIR, emptied));
        this.restoreStateDir(root);
        this.ignoreRuntime(root, changed);
        return changed;
    }

    // webpieces-disable no-any-unknown -- external JSON is opaque except for validated declaration metadata
    private readDocument(filename: string): Record<string, unknown> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- malformed input must name its repair file before migration writes anything
        try {
            // webpieces-disable no-any-unknown -- validate the root transport before inspecting declaration strings
            const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new InformAiError('Expected a JSON object.');
            // webpieces-disable no-any-unknown -- full policy schema validation remains in the owning loader
            return value as Record<string, unknown>;
            // webpieces-disable no-any-unknown -- convert external JSON/fs faults at this migration boundary
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `Repair ${filename} before directory migration: ${error.message}`,
                { cause: error },
            );
        }
    }

    // webpieces-disable no-any-unknown -- only the root declaration's package/config strings are inspected by migration
    private entries(document: Record<string, unknown>): LayoutDeclaration[] {
        const entries = document['rulePacks'];
        if (entries === undefined) return [];
        if (
            !Array.isArray(entries) ||
            entries.some(
                (entry) =>
                    !entry || typeof entry.package !== 'string' || typeof entry.config !== 'string',
            )
        )
            throw new InformAiError(
                `Invalid rulePacks declaration. Repair ${ROOT_CONFIG} before running ${MIGRATE_DIRS_COMMAND}.`,
            );
        return entries;
    }

    // webpieces-disable no-any-unknown -- migration preserves unrelated opaque root settings unchanged
    private declarations(
        document: Record<string, unknown>,
        root: string,
        moves: LayoutMove[],
    ): Map<string, string> {
        const renamed = new Map<string, string>();
        for (const entry of this.entries(document)) {
            const normalized = path.posix.normalize(entry.config.replace(/\\/g, '/'));
            const sourceDirectory = [WEBPIECES_TMP_DIR, RETIRED_STATE_DIR].find((directory) =>
                normalized.startsWith(`${directory}/`),
            );
            if (sourceDirectory !== undefined) {
                const target = normalized.replace(`${sourceDirectory}/`, `${POLICY_DIR}/`);
                renamed.set(entry.config, target);
                this.planFiles(path.join(root, normalized), path.join(root, target), moves);
            }
        }
        return renamed;
    }

    // The policy files releases up to 0.4.910 kept inside the state directory. Nothing else is planned.
    private planPolicy(root: string, moves: LayoutMove[]): void {
        const state = path.join(root, WEBPIECES_TMP_DIR);
        this.planFiles(path.join(state, LOCK_FILE), path.join(root, POLICY_DIR, LOCK_FILE), moves);
        this.planFiles(
            path.join(state, CATALOG_FILE),
            path.join(root, POLICY_DIR, path.basename(CATALOG_FILE)),
            moves,
        );
        this.planRules(root, RULES_DIR, moves);
    }

    private planRules(root: string, relative: string, moves: LayoutMove[]): void {
        const source = path.join(root, WEBPIECES_TMP_DIR, relative);
        const stat = fs.lstatSync(source, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isSymbolicLink())
            throw new InformAiError(
                `Cannot migrate symlink ${source}. Replace it with the intended policy file and rerun ${MIGRATE_DIRS_COMMAND}.`,
            );
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(source))
                this.planRules(root, path.join(relative, name), moves);
            return;
        }
        this.planFiles(source, path.join(root, POLICY_DIR, relative), moves);
    }

    private policyLeftovers(root: string): string[] {
        return [LOCK_FILE, CATALOG_FILE, RULES_DIR]
            .map((leaf) => path.posix.join(WEBPIECES_TMP_DIR, leaf))
            .filter((relative) => fs.lstatSync(path.join(root, relative), { throwIfNoEntry: false }));
    }

    private planFiles(source: string, target: string, moves: LayoutMove[]): void {
        if (!fs.existsSync(source)) return;
        if (moves.some((move) => move.source === source)) return;
        moves.push(new LayoutMove(source, target));
    }

    private checkPlan(root: string, moves: readonly LayoutMove[]): void {
        const targets = new Map<string, string>();
        for (const move of moves) {
            const previous = targets.get(move.target);
            if (previous !== undefined && previous !== move.source)
                throw new InformAiError(
                    `Directory migration made no changes: ${previous} and ${move.source} both target ${move.target}. Choose distinct policy paths before rerunning ${MIGRATE_DIRS_COMMAND}.`,
                );
            targets.set(move.target, move.source);
            this.checkMove(root, move);
        }
    }

    private checkMove(root: string, move: LayoutMove): void {
        for (const filename of [move.source, move.target]) this.assertInside(root, filename);
        const source = fs.lstatSync(move.source);
        if (!source.isFile())
            throw new InformAiError(`Policy migration requires a regular file: ${move.source}.`);
        if (!fs.existsSync(move.target)) return;
        const target = fs.lstatSync(move.target);
        if (!target.isFile() || !fs.readFileSync(move.source).equals(fs.readFileSync(move.target)))
            throw new InformAiError(
                `Directory migration made no changes: ${move.source} conflicts with ${move.target}. Preserve both versions, resolve the conflict, then rerun ${MIGRATE_DIRS_COMMAND}.`,
            );
    }

    private assertInside(root: string, filename: string): void {
        const relative = path.relative(root, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new InformAiError(`Migration path escapes repository: ${filename}.`);
        let current = root;
        for (const part of relative.split(path.sep)) {
            current = path.join(current, part);
            if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
                throw new InformAiError(`Migration path must not traverse a symlink: ${current}.`);
        }
    }

    private move(move: LayoutMove): void {
        fs.mkdirSync(path.dirname(move.target), { recursive: true });
        if (fs.existsSync(move.target)) fs.unlinkSync(move.source);
        else fs.renameSync(move.source, move.target);
    }

    private removeEmpty(directory: string): void {
        if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
        for (const name of fs.readdirSync(directory)) this.removeEmpty(path.join(directory, name));
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }

    // 0.4.911–0.4.914 named the state directory RETIRED_STATE_DIR. Take it back with ONE rename when
    // `.webpieces/` is free; otherwise leave it untouched and ignored — state is never walked or merged.
    private restoreStateDir(root: string): void {
        const retired = path.join(root, RETIRED_STATE_DIR);
        const state = path.join(root, WEBPIECES_TMP_DIR);
        if (!fs.lstatSync(retired, { throwIfNoEntry: false })?.isDirectory()) return;
        if (fs.lstatSync(state, { throwIfNoEntry: false })) return;
        fs.renameSync(retired, state);
    }

    // The whole state directory is ignored; the old `!.webpieces/rules/` exceptions are dropped because
    // no policy lives there any more. A `.webpieces-logs/` line is kept: a directory left in place stays ignored.
    private ignoreRuntime(root: string, changed: string[]): void {
        const filename = path.join(root, '.gitignore');
        const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
        const isStateLine = (line: string): boolean => /^!?\/?\.webpieces(?:\/|$)/.test(line.trim());
        const stateLines = previous.split('\n').filter((line: string) => isStateLine(line));
        if (stateLines.length === 1 && /^\/?\.webpieces\/?$/.test(stateLines[0].trim())) return;
        const lines = previous.split('\n').filter((line: string) => !isStateLine(line));
        this.write(
            filename,
            lines.join('\n').replace(/\n*$/, '') + `\n${WEBPIECES_TMP_DIR}/\n`,
            changed,
            root,
        );
    }

    private write(filename: string, content: string, changed: string[], root: string): void {
        if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === content) return;
        fs.writeFileSync(filename, content);
        changed.push(path.relative(root, filename));
    }
}
