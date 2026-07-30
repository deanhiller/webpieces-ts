import { describe, it, expect } from 'vitest';

import { CommandScanner, CommandSegment } from '../command-scan';
import { ShellSegmentScan, SegmentRole } from './shell-segment-scan';

const scanner = new CommandScanner();
const shell = new ShellSegmentScan(scanner);

// Classify every segment of a whole command line, in order.
function roles(command: string): SegmentRole[] {
    return scanner.segmentsWithPipes(command)
        .map((segment: CommandSegment): SegmentRole => shell.classify(segment).role);
}

describe('ShellSegmentScan — output shaping', () => {
    it('treats a PIPED filter as shaping, so it cannot veto an allowlisted producer', () => {
        expect(roles('git fetch origin main 2>&1 | tail -5')).toEqual(['command', 'shaping']);
        expect(roles('pnpm wp-cleanup 2>&1 | tail -40')).toEqual(['command', 'shaping']);
        expect(roles('git log --oneline -20 | head -5')).toEqual(['command', 'shaping']);
        expect(roles('git branch -a | wc -l')).toEqual(['command', 'shaping']);
    });

    // The pipe is what makes it a filter. Bare, the same word reads the working tree, so it must stay
    // a COMMAND and be judged like one.
    it('does NOT treat an UNPIPED filter as shaping', () => {
        expect(roles('cat src/foo.ts')).toEqual(['command']);
        expect(roles('tail -20 src/foo.ts')).toEqual(['command']);
        expect(roles('grep -r foo services/')).toEqual(['command']);
    });

    it('treats inert commands as shaping whether piped or not', () => {
        expect(roles('git fetch origin main 2>&1; echo "done"')).toEqual(['command', 'shaping']);
        expect(roles('cd ../other && git status')).toEqual(['shaping', 'command']);
    });

    // `2>&1` rewires an fd; `> file` creates one. Only the second can change the repo.
    it('never treats an output REDIRECT as inert', () => {
        expect(roles('echo "x" > src/foo.ts')).toEqual(['command']);
        expect(roles('echo "x" >> src/foo.ts')).toEqual(['command']);
        expect(roles('git status 2>&1')).toEqual(['command']);
    });
});

describe('ShellSegmentScan — shell structure', () => {
    it('reports loop scaffolding as structure and the BODY as the command it runs', () => {
        expect(roles('for b in one two; do gh pr list --head $b; done'))
            .toEqual(['structure', 'command', 'structure']);
    });

    it('strips leading keywords so the body is judged on its real command', () => {
        expect(shell.effectiveWords('do git status')).toEqual(['git', 'status']);
        expect(shell.effectiveWords('then cat src/foo.ts')).toEqual(['cat', 'src/foo.ts']);
        // Without this, `do` is the command name and every loop body walks past a git allowlist.
        expect(scanner.gitSubcommandOf(shell.effectiveWords('do git status'))).toBe('status');
    });

    it('classifies an if-guarded command by the command, not the keyword', () => {
        expect(roles('if git diff --quiet; then echo clean; fi'))
            .toEqual(['command', 'shaping', 'structure']);
    });
});
