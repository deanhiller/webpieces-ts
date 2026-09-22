import { describe, it, expect } from 'vitest';
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
        expect(codex).toContain('WAIT for the main agent');
        expect(codex).not.toContain('FRESH isolation');
    });
});
