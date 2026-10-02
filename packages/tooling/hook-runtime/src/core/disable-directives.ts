import { WEBPIECES_DISABLE } from '@webpieces/rules-config';
import type { IsLineDisabled } from './types';

// Exactly ONE disable form: `// webpieces-disable <rule>[, <rule2>] -- reason`.
// A rule (or comma-list of rules) is REQUIRED — there is no bare/`*` "disable everything",
// no `ai-hook-disable` alias, and no `-file`/`-next`/`-all` variants. A disable applies to
// the same line (when code precedes the `//`) or the next non-comment line.
const DIRECTIVE_RE = new RegExp(
    `//\\s*${WEBPIECES_DISABLE}\\s+([\\w-]+(?:\\s*,\\s*[\\w-]+)*)(?:\\s*--\\s*.*)?\\s*$`,
);
const COMMENT_PREFIX_RE = new RegExp(`^//\\s*${WEBPIECES_DISABLE}`);

export class DirectiveIndex {
    private readonly lineDisables: Map<number, Set<string>>;

    constructor(lineDisables: Map<number, Set<string>>) {
        this.lineDisables = lineDisables;
    }

    isLineDisabled(lineNum: number, ruleName: string): boolean {
        const set = this.lineDisables.get(lineNum);
        if (!set) return false;
        return set.has(ruleName);
    }
}

function parseRuleList(raw: string): readonly string[] {
    return raw
        .split(',')
        .map((s: string): string => s.trim())
        .filter((s: string): boolean => s.length > 0 && s !== '*');
}

function nextTargetLine(lines: readonly string[], lineIdx: number): number | null {
    for (let j = lineIdx + 1; j < lines.length; j += 1) {
        const trimmed = lines[j].trim();
        if (trimmed === '') continue;
        if (COMMENT_PREFIX_RE.test(trimmed)) continue;
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

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const match = line.match(DIRECTIVE_RE);
        if (!match) continue;
        const rules = parseRuleList(match[1]);
        if (rules.length === 0) continue;
        resolveTarget(line, lines, i, lineDisables, rules);
    }
    return new DirectiveIndex(lineDisables);
}

export function createIsLineDisabled(source: string): IsLineDisabled {
    const index = parseDirectives(source);
    return (lineNum: number, ruleName: string): boolean => index.isLineDisabled(lineNum, ruleName);
}
