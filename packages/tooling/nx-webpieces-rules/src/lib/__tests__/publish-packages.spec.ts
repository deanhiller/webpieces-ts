import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * RELEASE RESILIENCE — scripts/publish-packages.sh, tested by RUNNING IT.
 *
 * Run 585 published 10 runtime packages at 0.4.585 and left cloudtasks-client plus the whole tooling
 * family at 0.4.584, because entry 21 of 28 hit a transient npm 404 (trusted publishing masks an
 * expired OIDC token that way) and `set -e` killed the loop. Two properties had to change, and
 * asserting on the SHAPE OF THE FILE would prove neither of them:
 *
 *   1. a transient failure is retried, and "already published at this version" counts as success —
 *      which is what makes re-running a failed release the recovery, rather than a second abort;
 *   2. one dead package no longer strands the rest, and a partial release exits NON-ZERO with a
 *      summary naming both halves.
 *
 * So this runs the REAL script, in a throwaway workspace, against a FAKE `npm` first on PATH. Mirrors
 * guarantee-root.spec.ts, which tests POSIX sh the same way for the same reason.
 *
 * WHY THIS CANNOT PUBLISH ANYTHING. The script's only registry contact is `npm publish`, and three
 * independent things stop it reaching npmjs.org: the fake `npm` is prepended to PATH and never execs
 * the real one; `assertNpmIsFake()` below fails the suite if PATH resolution ever picks something
 * else; and `npm_config_registry` is pointed at a discard port, so even a real npm reaching this env
 * could not talk to the registry. The fake also refuses any argv that is not `publish`.
 */

/**
 * SLOW BY NATURE: each `it()` runs the real publish script over ~28 package directories, so it is ~28
 * `npm publish` spawns into the fake shim plus a `pnpm pack` each. It gets 120s rather than the 45s
 * global from vitest.setup.mts, which grants that to every `packages/tooling/**` suite and records the
 * measurements — this file's worst observation was 93,477ms for a test that takes 956ms idle.
 */

/** How the fake npm should behave for one package. Data-only. */
class PublishPlan {
    constructor(
        public readonly dir: string,
        /** `ok` | `conflict` | `always-fail` | `flaky:<n>` (fail the first n attempts, then succeed). */
        public readonly behaviour: string,
    ) {}
}

/** What one run of the real script did. Data-only. */
class PublishRun {
    constructor(
        public readonly status: number,
        public readonly output: string,
        /** Every `dist/<dir>` the fake npm was asked to publish, in call order, retries included. */
        public readonly attempts: readonly string[],
    ) {}

    attemptsFor(dir: string): number {
        return this.attempts.filter((d: string): boolean => d === dir).length;
    }

    firstAttemptIndex(dir: string): number {
        return this.attempts.indexOf(dir);
    }
}

const FAKE_NPM = `#!/bin/sh
# Fake npm for publish-packages.spec.ts. Talks to no network, ever.
set -u
if [ "\${1:-}" != "publish" ]; then
    echo "fake npm refuses argv: $*" >&2
    exit 1
fi
target=""
for a in "$@"; do
    case "$a" in dist/*) target="$a" ;; esac
done
dir="\${target#dist/}"
printf '%s\\n' "$dir" >> "$FAKE_NPM_LOG"

key="$(printf '%s' "$dir" | tr '/' '_')"
plan="ok"
[ -f "$FAKE_NPM_PLAN/$key" ] && plan="$(cat "$FAKE_NPM_PLAN/$key")"

n=0
[ -f "$FAKE_NPM_PLAN/$key.count" ] && n="$(cat "$FAKE_NPM_PLAN/$key.count")"
n=$((n + 1))
printf '%s' "$n" > "$FAKE_NPM_PLAN/$key.count"

fail_404() {
    echo "npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access" >&2
    echo "npm error code E404" >&2
    echo "npm error 404 Not Found - PUT https://registry.npmjs.org/@webpieces%2ffake" >&2
    exit 1
}

case "$plan" in
    ok)          echo "+ @webpieces/fake@0.4.585"; exit 0 ;;
    always-fail) fail_404 ;;
    conflict)
        echo "npm error code EPUBLISHCONFLICT" >&2
        echo "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@webpieces%2ffake - You cannot publish over the previously published versions: 0.4.585." >&2
        exit 1 ;;
    flaky:*)
        if [ "$n" -le "\${plan#flaky:}" ]; then fail_404; fi
        echo "+ @webpieces/fake@0.4.585"; exit 0 ;;
    *) echo "fake npm: unknown plan '$plan'" >&2; exit 1 ;;
esac
`;

function repoRoot(): string {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error('could not locate pnpm-workspace.yaml above ' + __dirname);
        dir = parent;
    }
    return dir;
}

const REPO_ROOT = repoRoot();
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'publish-packages.sh');

/** The ORDER array, read out of the real script — the spec must never keep its own copy to drift from. */
function readOrder(): readonly string[] {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    const body = /^ORDER=\(([\s\S]*?)^\)$/m.exec(text);
    if (body === null) throw new Error('could not find ORDER=( ... ) in ' + SCRIPT);
    return body[1]
        .split('\n')
        .map((line: string): string => line.trim())
        .filter((line: string): boolean => line.startsWith('packages/'));
}

const ORDER = readOrder();

// webpieces-disable no-any-unknown -- opaque package.json; every field is narrowed at its use site
function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** The @webpieces packages `dir` needs installed alongside it (devDependencies are not shipped). */
function webpiecesDepsOf(dir: string): readonly string[] {
    const pkg = readJson(path.join(REPO_ROOT, dir, 'package.json'));
    const names = new Set<string>();
    for (const field of ['dependencies', 'peerDependencies']) {
        const deps = pkg[field];
        if (typeof deps !== 'object' || deps === null) continue;
        for (const name of Object.keys(deps)) {
            if (name.startsWith('@webpieces/')) names.add(name);
        }
    }
    return [...names];
}

function packageNameOf(dir: string): string {
    return String(readJson(path.join(REPO_ROOT, dir, 'package.json'))['name']);
}

/**
 * A throwaway workspace shaped exactly the way the script's preflight expects: one publishable source
 * manifest and one built dist manifest per ORDER entry, and nothing else — so preflight passes and the
 * only thing under test is the publish loop.
 */
class FakeRelease {
    readonly root: string;
    private readonly binDir: string;
    private readonly planDir: string;
    private readonly logFile: string;

    constructor() {
        this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-publish-'));
        this.binDir = path.join(this.root, 'fakebin');
        this.planDir = path.join(this.root, 'plan');
        this.logFile = path.join(this.root, 'npm-calls.log');

        fs.mkdirSync(this.binDir, { recursive: true });
        fs.mkdirSync(this.planDir, { recursive: true });
        fs.mkdirSync(path.join(this.root, 'scripts'), { recursive: true });
        fs.copyFileSync(SCRIPT, path.join(this.root, 'scripts', 'publish-packages.sh'));

        const npmPath = path.join(this.binDir, 'npm');
        fs.writeFileSync(npmPath, FAKE_NPM);
        fs.chmodSync(npmPath, 0o755);

        for (const dir of ORDER) {
            const manifest = JSON.stringify({
                name: '@webpieces/' + path.basename(dir),
                version: '0.4.585',
                publishConfig: { access: 'public' },
            });
            for (const base of [dir, path.join('dist', dir)]) {
                const full = path.join(this.root, base);
                fs.mkdirSync(full, { recursive: true });
                fs.writeFileSync(path.join(full, 'package.json'), manifest);
            }
        }
    }

    dispose(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    private env(): NodeJS.ProcessEnv {
        return {
            ...process.env,
            PATH: this.binDir + path.delimiter + (process.env['PATH'] ?? ''),
            PUBLISH_FLAGS: '--access public',
            PUBLISH_ATTEMPTS: '3',
            PUBLISH_RETRY_SLEEP: '0',
            FAKE_NPM_LOG: this.logFile,
            FAKE_NPM_PLAN: this.planDir,
            // Belt-and-braces: a discard port, so even a real npm inheriting this env reaches nothing.
            npm_config_registry: 'http://127.0.0.1:9/',
        };
    }

    /** Fails the suite if PATH would resolve `npm` to anything but the stub. */
    assertNpmIsFake(): void {
        const r = spawnSync('sh', ['-c', 'command -v npm'], { env: this.env(), encoding: 'utf8' });
        expect((r.stdout ?? '').trim()).toBe(path.join(this.binDir, 'npm'));
    }

    run(...plans: readonly PublishPlan[]): PublishRun {
        fs.rmSync(this.planDir, { recursive: true, force: true });
        fs.mkdirSync(this.planDir, { recursive: true });
        fs.writeFileSync(this.logFile, '');
        for (const plan of plans) {
            fs.writeFileSync(path.join(this.planDir, plan.dir.replace(/\//g, '_')), plan.behaviour);
        }

        const r = spawnSync('bash', ['scripts/publish-packages.sh'], {
            cwd: this.root,
            env: this.env(),
            encoding: 'utf8',
        });
        const attempts = fs.readFileSync(this.logFile, 'utf8').split('\n').filter((l: string): boolean => l !== '');
        return new PublishRun(r.status ?? -1, (r.stdout ?? '') + (r.stderr ?? ''), attempts);
    }
}

describe('ORDER is a valid dependency order, re-derived from the real manifests', () => {
    it('places every package after every @webpieces package it depends on', () => {
        const positionOf = new Map<string, number>();
        ORDER.forEach((dir: string, i: number): void => { positionOf.set(packageNameOf(dir), i); });

        const violations: string[] = [];
        ORDER.forEach((dir: string, i: number): void => {
            for (const dep of webpiecesDepsOf(dir)) {
                const at = positionOf.get(dep);
                if (at === undefined) violations.push(`${dir} depends on ${dep}, which ORDER never publishes`);
                else if (at > i) violations.push(`${dir} (#${i}) is published before its dependency ${dep} (#${at})`);
            }
        });
        expect(violations).toEqual([]);
    });

    /**
     * The reorder run 585 bought. The tooling family is what this repo governs itself with, so a
     * partial release that strands it is the worst case — and nothing in it depends on a runtime
     * package, so nothing had to be traded to move it to the front.
     */
    it('publishes the whole tooling family before any runtime package', () => {
        const lastTooling = ORDER.map((d: string): boolean => d.startsWith('packages/tooling/')).lastIndexOf(true);
        const toolingCount = ORDER.filter((d: string): boolean => d.startsWith('packages/tooling/')).length;
        expect(toolingCount).toBe(6);
        expect(lastTooling).toBe(toolingCount - 1);
    });

    it('depends on no runtime package from the tooling family (the reason the move is free)', () => {
        for (const dir of ORDER.filter((d: string): boolean => d.startsWith('packages/tooling/'))) {
            for (const dep of webpiecesDepsOf(dir)) {
                expect(dep.replace('@webpieces/', ''),
                    `${dir} would drag a runtime package to the front of ORDER`)
                    .toMatch(/^(rules-config|pr-gate|eslint-rules|ai-hook-rules|code-rules|nx-webpieces-rules)$/);
            }
        }
    });
});

describe('the publish loop, run for real against a fake npm', () => {
    let release: FakeRelease;

    beforeAll((): void => {
        release = new FakeRelease();
        release.assertNpmIsFake();
    });

    afterAll((): void => { release.dispose(); });

    it('publishes every package exactly once when nothing fails', () => {
        const run = release.run();
        expect(run.status, run.output).toBe(0);
        expect(run.attempts).toEqual([...ORDER]);
        expect(run.output).toContain(`✅ Published ${ORDER.length} package(s)`);
    });

    // THE RETRY. Two 404s in a row on the exact package that killed run 585, then success.
    it('retries a transient failure and succeeds without stranding anything', () => {
        const run = release.run(new PublishPlan('packages/cloud/cloudtasks-client', 'flaky:2'));
        expect(run.status, run.output).toBe(0);
        expect(run.attemptsFor('packages/cloud/cloudtasks-client')).toBe(3);
        expect(run.attemptsFor('packages/http/http-server')).toBe(1);
        expect(run.output).toContain('retrying in 0s');
        expect(run.output).toContain(`✅ Published ${ORDER.length} package(s)`);
    });

    it('stops retrying at PUBLISH_ATTEMPTS rather than looping forever', () => {
        const run = release.run(new PublishPlan('packages/cloud/cloudtasks-client', 'always-fail'));
        expect(run.attemptsFor('packages/cloud/cloudtasks-client')).toBe(3);
    });

    /**
     * THE RE-RUN PATH. This is what a human does after a partial release: run the script again with the
     * same version. Every package that already went out answers EPUBLISHCONFLICT, and before this change
     * the first one aborted the whole thing — so the stragglers the re-run existed for were never
     * reached. Modelled here with the FIRST entry conflicting and a later one still needing publishing.
     */
    it('treats an already-published version as success and keeps going', () => {
        const run = release.run(
            new PublishPlan('packages/tooling/rules-config', 'conflict'),
            new PublishPlan('packages/core/core-util', 'conflict'),
        );
        expect(run.status, run.output).toBe(0);
        expect(run.output).toContain('already published at this version');
        // One attempt, not three: a conflict is a verdict, not a transient worth retrying.
        expect(run.attemptsFor('packages/tooling/rules-config')).toBe(1);
        expect(run.attempts).toEqual([...ORDER]);
    });

    /**
     * THE BLAST RADIUS. A genuinely dead package must no longer take everything after it down with it,
     * and the run must still fail loudly — resilience without an accurate verdict is how a split release
     * goes unnoticed for days.
     */
    it('publishes the rest, then fails with a summary naming both halves', () => {
        const dead = 'packages/cloud/cloudtasks-client';
        const run = release.run(new PublishPlan(dead, 'always-fail'));

        expect(run.status).toBe(1);
        expect(run.output).toContain('PARTIAL RELEASE');
        expect(run.output).toContain(`❌ ${dead}`);
        expect(run.output).toContain('✅ packages/http/http-server');
        expect(run.output).toContain('Re-run this script');

        // Every other package was attempted, including the ones AFTER the failure — the loop no longer aborts.
        for (const dir of ORDER) {
            expect(run.attemptsFor(dir), `${dir} was never attempted`).toBeGreaterThan(0);
        }
    });

    // The whole point of the reorder: the tooling family is out the door before the entry that broke 585.
    it('has already published the tooling family before the package that broke run 585', () => {
        const run = release.run(new PublishPlan('packages/cloud/cloudtasks-client', 'always-fail'));
        const brokeAt = run.firstAttemptIndex('packages/cloud/cloudtasks-client');
        for (const dir of ORDER.filter((d: string): boolean => d.startsWith('packages/tooling/'))) {
            expect(run.firstAttemptIndex(dir)).toBeLessThan(brokeAt);
            expect(run.output).toContain(`✅ ${dir}`);
        }
    });

    it('does not swallow a real failure into a green exit code', () => {
        const run = release.run(new PublishPlan('packages/tooling/rules-config', 'always-fail'));
        expect(run.status).toBe(1);
        expect(run.output).not.toContain(`✅ Published ${ORDER.length} package(s)`);
    });
});
