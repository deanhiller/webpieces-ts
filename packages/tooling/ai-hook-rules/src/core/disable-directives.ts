import type { IsLineDisabled } from './types';

const DIRECTIVE_RE =
    /\/\/\s*(?:ai-hook-disable|webpieces-disable)(?:-(next|file|all))?(?:\s+([\w\-*,\s]+?))?(?:\s*--\s*(.*))?\s*$/;

export class DirectiveIndex {
    private readonly lineDisables: Map<number, Set<string>>;
    private readonly fileDisables: Set<string>;

    constructor(lineDisables: Map<number, Set<string>>, fileDisables: Set<string>) {
        this.lineDisables = lineDisables;
        this.fileDisables = fileDisables;
    }

    isLineDisabled(lineNum: number, ruleName: string): boolean {
        if (this.fileDisables.has('*') || this.fileDisables.has(ruleName)) return true;
        const set = this.lineDisables.get(lineNum);
        if (!set) return false;
        return set.has('*') || set.has(ruleName);
    }
}

function parseRuleList(raw: string | undefined): readonly string[] {
    if (!raw || raw.trim() === '' || raw.trim() === '*') return ['*'];
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function nextTargetLine(lines: readonly string[], lineIdx: number): number | null {
    for (let j = lineIdx + 1; j < lines.length; j += 1) {
        const trimmed = lines[j].trim();
        if (trimmed === '') continue;
        if (/^\/\/\s*(?:ai-hook-disable|webpieces-disable)/.test(trimmed)) continue;
        return j + 1;
    }
    return null;
}

function addDisable(map: Map<number, Set<string>>, lineNum: number, rules: readonly string[]): void {
    if (!map.has(lineNum)) map.set(lineNum, new Set<string>());
    const set = map.get(lineNum)!;
    for (const r of rules) set.add(r);
}

function resolveTarget(
    line: string, lines: readonly string[], i: number,
    map: Map<number, Set<string>>, rules: readonly string[],
): void {
    const beforeComment = line.slice(0, line.indexOf('//')).trim();
    if (beforeComment !== '') {
        addDisable(map, i + 1, rules);
    } else {
        const target = nextTargetLine(lines, i);
        if (target !== null) addDisable(map, target, rules);
    }
}

export function parseDirectives(source: string): DirectiveIndex {
    const lines = source.split('\n');
    const lineDisables = new Map<number, Set<string>>();
    const fileDisables = new Set<string>();

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const match = line.match(DIRECTIVE_RE);
        if (!match) continue;
        const variant = match[1] || null;
        const rules = parseRuleList(match[2] || '');

        if (variant === 'file') {
            if (i < 20) { for (const r of rules) fileDisables.add(r); }
            continue;
        }
        if (variant === 'next') {
            const target = nextTargetLine(lines, i);
            if (target !== null) addDisable(lineDisables, target, rules);
            continue;
        }
        if (variant === 'all') {
            resolveTarget(line, lines, i, lineDisables, ['*']);
            continue;
        }
        resolveTarget(line, lines, i, lineDisables, rules);
    }
    return new DirectiveIndex(lineDisables, fileDisables);
}

export function createIsLineDisabled(source: string): IsLineDisabled {
    const index = parseDirectives(source);
    return (lineNum: number, ruleName: string): boolean => index.isLineDisabled(lineNum, ruleName);
}
