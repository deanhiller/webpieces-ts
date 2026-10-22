import * as fs from 'node:fs';
import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { GitProcessApi, GitProcessClient, InformAiError, MIGRATE_DIRS_COMMAND } from '@webpieces/tooling-common';
import type { PackPolicyDeclaration } from './pack-policy-files';
import { ConfigRepairError, EditFileCure, RunCommandCure } from './config-repair-error';

/** POSIX single-quoting for a path printed inside a command the reader will paste. */
class ShellQuote {
    quote(value: string): string {
        return /^[A-Za-z0-9_./@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    }
}

/**
 * Declared policy files git's index does not hold (#1327) — the PR gate's refusal (`wp-ci`), never a
 * config-load one (#1355): the guard hooks do not check tracking, so nothing blocks the `git add` cure.
 */
export class UntrackedPolicyError extends ConfigRepairError {
    readonly untracked: readonly string[];

    constructor(untracked: readonly string[]) {
        const quoted = untracked.map((file: string) => new ShellQuote().quote(file)).join(' ');
        super(
            [
                'Webpieces policy files are not tracked by git. Policy is shared through the git index, so every',
                'declared owner file must be staged and committed with your change. Untracked:',
                ...untracked.map((file: string) => `  ${file}`),
            ].join('\n'),
            [
                new RunCommandCure(
                    `git add -- ${quoted}`,
                    `git add -- ${quoted} — stages exactly the untracked files listed above.`,
                ),
                new RunCommandCure(
                    `${MIGRATE_DIRS_COMMAND} --stage`,
                    `${MIGRATE_DIRS_COMMAND} --stage — stages webpieces.config.json, .gitignore and every declared owner file.`,
                ),
            ],
        );
        this.name = 'UntrackedPolicyError';
        this.untracked = untracked;
    }
}

/**
 * Git repositories must share policy through their index, including rules switched OFF.
 *
 * Checked at the PR gate and in CI (`wp-ci` → ConfigLoader.assertPolicyTracked), NOT on config load:
 * it is a commit-time invariant that costs two `git` processes, and config load runs on every guard-hook
 * invocation (#1355). `stage()` is wp-migrate-dirs' cure and is unchanged.
 */
@injectable(bindingScopeValues.Singleton)
export class PolicyTracking {
    // Defaulted so the non-DI call sites (ConfigLoader, wp-migrate-dirs) can `new PolicyTracking()`, while
    // inversify injects the container's git edge — which is what a feature test rebinds.
    constructor(private readonly git: GitProcessApi = new GitProcessClient()) {}

    async check(root: string, declarations: readonly PackPolicyDeclaration[]): Promise<void> {
        // Standalone non-git schema validation is supported; CI and governed checkouts have .git.
        if (!fs.existsSync(path.join(root, '.git'))) return;
        const files = this.files(root, declarations);
        // `check-ignore` exits 0 when something IS ignored and 1 when nothing is; anything else is a failure.
        const ignored = await this.git.run(['check-ignore', '--no-index', '--', ...files], root);
        if (ignored.code !== 0 && ignored.code !== 1)
            throw new InformAiError(
                `Cannot verify policy ignore status: ${ignored.stderr}. Repair git access, then retry.`,
            );
        if (ignored.stdout.trim())
            throw new ConfigRepairError(
                `Committed Webpieces policy is gitignored:\n${ignored.stdout}Only .webpieces/ belongs in .gitignore; .webpieces-config/ must be tracked.`,
                [
                    new EditFileCure(
                        path.join(root, '.gitignore'),
                        `Delete the .gitignore patterns that match the files listed above.`,
                    ),
                ],
            );
        const untracked = await this.untracked(root, files);
        if (untracked.length) throw new UntrackedPolicyError(untracked);
    }

    async stage(root: string, declarations: readonly PackPolicyDeclaration[]): Promise<void> {
        // `.webpieces/` is the gitignored state directory, so `git add` refuses its paths. Untrack whatever
        // policy older releases committed there with `rm --cached`, which keeps every file on disk.
        const retired = await this.git.run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.webpieces'], root);
        if (!retired.ok)
            throw new InformAiError(
                `Cannot untrack retired policy paths in .webpieces/: ${retired.stderr}. Verify git access before retrying.`,
            );
        const result = await this.git.run(
            [
                '--literal-pathspecs',
                'add',
                '-A',
                '--',
                'webpieces.config.json',
                '.gitignore',
                ...this.files(root, declarations),
            ],
            root,
        );
        if (!result.ok)
            throw new InformAiError(
                `Could not stage Webpieces policy: ${result.stderr}. Remove policy ignore patterns and verify git access before retrying.`,
            );
    }

    /** Which of `files` git's index does not hold — each one named, never git's own pathspec advice. */
    private async untracked(root: string, files: readonly string[]): Promise<string[]> {
        const listed = await this.git.run(['--literal-pathspecs', 'ls-files', '-z', '--', ...files], root);
        if (!listed.ok)
            throw new InformAiError(
                `Cannot verify policy tracking status: ${listed.stderr}. Repair git access, then retry.`,
            );
        const tracked = new Set(
            listed.stdout
                .split('\0')
                .filter((entry: string) => entry !== '')
                .map((entry: string) => path.normalize(entry)),
        );
        return files.filter((file: string) => !tracked.has(path.normalize(file)));
    }

    private files(root: string, declarations: readonly PackPolicyDeclaration[]): string[] {
        const declared = declarations.map((declaration) => declaration.config);
        return [
            ...new Set(
                declared.flatMap((filename) => [
                    filename,
                    path.relative(
                        fs.realpathSync(root),
                        fs.realpathSync(path.join(root, filename)),
                    ),
                ]),
            ),
        ];
    }
}
