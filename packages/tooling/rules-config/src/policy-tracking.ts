import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InformAiError, MIGRATE_DIRS_COMMAND } from '@webpieces/tooling-common';
import type { PackPolicyDeclaration } from './pack-policy-files';
import { ConfigRepairError, EditFileCure, RunCommandCure } from './config-repair-error';

/** POSIX single-quoting for a path printed inside a command the reader will paste. */
class ShellQuote {
    quote(value: string): string {
        return /^[A-Za-z0-9_./@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    }
}

/**
 * Declared policy files git's index does not hold (#1327). Its own type because the guard hook treats it
 * specially: while THIS refusal is why the config will not load, a plain `git add` is let through
 * (agent-workflow-rules `PolicyStagingCommand`) — staging is literally the cure, so refusing it was a loop.
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
                'A plain `git add` is permitted while this refusal is active.',
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

/** Git repositories must share policy through their index, including rules switched OFF. */
export class PolicyTracking {
    check(root: string, declarations: readonly PackPolicyDeclaration[]): void {
        // Standalone non-git schema validation is supported; CI and governed checkouts have .git.
        if (!fs.existsSync(path.join(root, '.git'))) return;
        const files = this.files(root, declarations);
        const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', ...files], {
            cwd: root,
            encoding: 'utf8',
        });
        if (ignored.status !== 0 && ignored.status !== 1)
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
        const untracked = this.untracked(root, files);
        if (untracked.length) throw new UntrackedPolicyError(untracked);
    }

    stage(root: string, declarations: readonly PackPolicyDeclaration[]): void {
        // `.webpieces/` is the gitignored state directory, so `git add` refuses its paths. Untrack whatever
        // policy older releases committed there with `rm --cached`, which keeps every file on disk.
        const retired = spawnSync(
            'git',
            ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.webpieces'],
            { cwd: root, encoding: 'utf8' },
        );
        if (retired.status !== 0)
            throw new InformAiError(
                `Cannot untrack retired policy paths in .webpieces/: ${retired.stderr}. Verify git access before retrying.`,
            );
        const result = spawnSync(
            'git',
            [
                '--literal-pathspecs',
                'add',
                '-A',
                '--',
                'webpieces.config.json',
                '.gitignore',
                ...this.files(root, declarations),
            ],
            { cwd: root, encoding: 'utf8' },
        );
        if (result.status !== 0)
            throw new InformAiError(
                `Could not stage Webpieces policy: ${result.stderr}. Remove policy ignore patterns and verify git access before retrying.`,
            );
    }

    /** Which of `files` git's index does not hold — each one named, never git's own pathspec advice. */
    private untracked(root: string, files: readonly string[]): string[] {
        const listed = spawnSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', ...files], {
            cwd: root,
            encoding: 'utf8',
        });
        if (listed.status !== 0)
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
