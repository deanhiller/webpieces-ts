import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InformAiError, MIGRATE_DIRS_COMMAND } from '@webpieces/tooling-common';
import type { PackPolicyDeclaration } from './pack-policy-files';
import { ConfigRepairError, EditFileCure, RunCommandCure } from './config-repair-error';

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
        const tracked = spawnSync(
            'git',
            ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', ...files],
            {
                cwd: root,
                encoding: 'utf8',
            },
        );
        if (tracked.status !== 0)
            throw new ConfigRepairError(
                `Webpieces policy must be tracked by git: ${tracked.stderr}\nReview the policy files, stage them, and commit them with your change.`,
                [
                    new RunCommandCure(
                        `${MIGRATE_DIRS_COMMAND} --stage`,
                        `${MIGRATE_DIRS_COMMAND} --stage — stages the declaration and the owner files.`,
                    ),
                ],
            );
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
