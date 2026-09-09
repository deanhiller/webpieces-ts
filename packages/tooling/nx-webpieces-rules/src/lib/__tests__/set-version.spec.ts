import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/** Run the real release stamper against disposable manifests, never the working tree. */
describe('release version stamping', () => {
    it('stamps source and dist runtime/dev workspace dependencies while preserving unrelated specs', () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-set-version-'));
        try {
            fs.writeFileSync(path.join(scratch, 'VERSION'), '0.4\n');
            const manifests = [
                'packages/core/ipc-bridge/package.json',
                'dist/packages/core/ipc-bridge/package.json',
            ];
            for (const file of manifests) {
                fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
                fs.writeFileSync(
                    path.join(scratch, file),
                    JSON.stringify({
                        name: '@webpieces/ipc-bridge',
                        version: '0.0.0-dev',
                        dependencies: { '@webpieces/core-util': 'workspace:*', tslib: '2.8.1' },
                        devDependencies: {
                            '@webpieces/core-mock': 'workspace:*',
                            vitest: '^4.1.10',
                        },
                    }),
                );
            }
            const noDependencies = 'packages/core/empty/package.json';
            fs.mkdirSync(path.dirname(path.join(scratch, noDependencies)), { recursive: true });
            fs.writeFileSync(
                path.join(scratch, noDependencies),
                JSON.stringify({ name: '@webpieces/empty', version: '0.0.0-dev' }),
            );
            const script = path.resolve(__dirname, '../../../../../../scripts/set-version.sh');
            const run = spawnSync('bash', [script], {
                cwd: scratch,
                encoding: 'utf8',
                env: { ...process.env, BUILD_NUMBER: '777' },
            });
            expect(run.error).toBeUndefined();
            expect(run.status, run.stdout + run.stderr).toBe(0);
            for (const file of manifests) {
                const manifest = JSON.parse(fs.readFileSync(path.join(scratch, file), 'utf8'));
                expect(manifest.version).toBe('0.4.777');
                expect(manifest.dependencies).toEqual({
                    '@webpieces/core-util': '0.4.777',
                    tslib: '2.8.1',
                });
                expect(manifest.devDependencies).toEqual({
                    '@webpieces/core-mock': '0.4.777',
                    vitest: '^4.1.10',
                });
                expect(JSON.stringify(manifest)).not.toContain('workspace:');
            }
            expect(JSON.parse(fs.readFileSync(path.join(scratch, noDependencies), 'utf8'))).toEqual(
                { name: '@webpieces/empty', version: '0.4.777' },
            );
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });
});
