import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { specTempDirs } from '@webpieces/rules-config';
import { AiType } from './agent-event';
import { EffectiveTree } from './effective-tree';
import { VersionSyncGuard } from './version-sync';

const PKG = '@webpieces/nx-webpieces-rules';

// Real manifests: the guard reads files, so a fabricated path would read "in sync" and pass vacuously.
function writePin(root: string, version: string): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n  '${PKG}': ${version}\n`);
}

function writeInstalled(root: string, version: string): void {
    const dir = path.join(root, 'node_modules', PKG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PKG, version }));
}

/** `core.hooksPath=/dev/null`: this machine installs GLOBAL hooks that reject fixture commits. */
function runGit(root: string, args: readonly string[]): void {
    spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
}

/** Typed FROM the main tree at a worktree, so governedRoot and mainRoot coincide. */
function skewReport(main: string, wt: string, aiType: AiType): string {
    return new VersionSyncGuard().block('pnpm build', new EffectiveTree(main, wt, wt, main, main, 'worktree'), aiType) ?? '';
}

/** A main + worktree fixture with each leg set as given; `null` leaves this tree's install unwritten. */
function fixture(mainPin: string, mainInstalled: string, wtPin: string, wtInstalled: string | null): readonly string[] {
    const base = specTempDirs.make('wp-vsync-harness-');
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    writePin(main, mainPin);
    writeInstalled(main, mainInstalled);
    writePin(wt, wtPin);
    if (wtInstalled !== null) writeInstalled(wt, wtInstalled);
    return [main, wt];
}

/**
 * The deliberate-bump skew (C'), rendered against a REAL repo: `isDeliberateBump` asks git whether this
 * branch touched the manifest, so a fabricated path answers "no", takes the generic branch, and makes
 * every assertion about the bump text vacuous. Exported for version-sync.spec.ts's bump suite.
 */
export function renderBumpSkewReport(aiType: AiType = 'claude-code'): string {
    const base = specTempDirs.make('wp-vsync-bump-');
    const main = path.join(base, 'main');
    writePin(main, '0.4.634');
    writeInstalled(main, '0.4.634');
    const wt = path.join(base, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    // A real repo with a real uncommitted bump — that dirty manifest IS the signal.
    runGit(wt, ['init', '-q']);
    writePin(wt, '0.4.634');
    runGit(wt, ['add', '.']);
    runGit(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    writePin(wt, '0.4.638');
    return skewReport(main, wt, aiType);
}

/**
 * EVERY skew report this guard can print — each of the five `SkewCase`s × both harnesses — keyed
 * `<case> × <harness>`. Exported for `rules/no-turn-ending-instructions.spec.ts` (issue #1000): the
 * escalation block told subagents "Forwarding that message IS the end of your turn" for a release after
 * #902 because the turn-ending detector rendered wait-spin-guard and nothing else. A sweep that renders
 * one case of one harness is the same hole one level down, so this renders all ten.
 */
export function renderEverySkewReport(): Map<string, string> {
    const reports = new Map<string, string>();
    const aiTypes: readonly AiType[] = ['claude-code', 'codex'];
    for (const aiType of aiTypes) {
        const inconsistent = fixture('0.4.616', '0.4.620', '0.4.620', null);
        reports.set(`main-inconsistent × ${aiType}`, skewReport(inconsistent[0], inconsistent[1], aiType));
        const ahead = fixture('0.4.616', '0.4.616', '0.4.612', null);
        reports.set(`main-ahead × ${aiType}`, skewReport(ahead[0], ahead[1], aiType));
        const behind = fixture('0.4.612', '0.4.612', '0.4.616', null);
        reports.set(`main-behind × ${aiType}`, skewReport(behind[0], behind[1], aiType));
        const stale = fixture('0.4.616', '0.4.616', '0.4.616', '0.4.500');
        reports.set(`worktree-stale × ${aiType}`, skewReport(stale[0], stale[1], aiType));
        reports.set(`bump × ${aiType}`, renderBumpSkewReport(aiType));
    }
    return reports;
}

// The escalating skew: main is BEHIND this worktree, so only the main agent can fix it.
function report(aiType: AiType): string {
    const base = specTempDirs.make('wp-vsync-harness-');
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    writePin(main, '0.4.612');
    writeInstalled(main, '0.4.612');
    writePin(wt, '0.4.616');
    const tree = new EffectiveTree(main, wt, wt, main, main, 'worktree');
    return new VersionSyncGuard().block('pnpm build', tree, aiType) ?? '';
}

/**
 * Issue #863 §4. Under Claude Code a worktree-isolated subagent that hands back has its unchanged worktree
 * REAPED, and one resumed afterwards lands in the PRIMARY clone — which is what happened to the first agent
 * on that very issue. So the Claude Code cure asks for a FRESH isolated subagent and never to be resumed.
 * Codex keeps the same agent in the same checkout, so its "tell me when it is complete" wording stays.
 */
describe('VersionSyncGuard — what happens after the main tree is synced, per harness', () => {
    it('tells a Claude Code coordinator to spawn a FRESH worktree subagent, never to resume this one', () => {
        const claude = report('claude-code');
        expect(claude).toContain('spawn a FRESH isolation: "worktree" subagent to redo this task');
        expect(claude).toContain('message this agent again');
        expect(claude).not.toContain('continue working');
        expect(claude).not.toContain('resume me');
        expect(claude).not.toContain('then resume');
        expect(claude).not.toContain('tell me when');
    });

    it('keeps the Codex wording: the same agent continues in the same checkout', () => {
        const codex = report('codex');
        expect(codex).toContain('Tell me when that is complete so I can continue working');
        // The three-move wait shape (issue #1000): the efficient option, the wasteful one, and nothing
        // about when a turn ends — "then resume — nothing between" was a control-flow ruling.
        expect(codex).toContain('Be efficient with tokens');
        expect(codex).toContain('instead of re-running blocked calls');
        expect(codex).not.toContain('nothing between');
        expect(codex).not.toContain('then resume');
        expect(codex).not.toContain('FRESH isolation');
    });
});
