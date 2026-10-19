import { ConfigObject, FieldDef, LocalRule, LocalRuleConfig, LocalRuleFile, LocalRuleFinding, Option, ts }
    from '@webpieces/webpieces-tooling/local-rules';

/**
 * webpieces-ts's own repo-local rule (#1320), and the dogfood of repo-local rule packs (#1314).
 *
 * `.claude/rules/no-backwards-compat.md` lists a new deprecated-JSDoc-tag on a surface as shim shape #2:
 * the tag is a human-facing signal, invisible to an agent at the moment it decides what to write, so an
 * accepted shape is never migrated. The policy is to DELETE the old spelling and let the compile error
 * migrate every caller. Until now only a reviewer enforced it; this rule refuses it at Write/Edit time
 * and at the build gate.
 */
export class NoDeprecatedTagRule extends LocalRule<LocalRuleConfig> {
    readonly id = 'no-deprecated-tag';
    readonly description = 'No webpieces surface is marked deprecated: delete the old spelling instead (.claude/rules/no-backwards-compat.md).';
    readonly files = ['packages/**/*.ts', 'libraries/**/*.ts'];
    readonly cures = [
        new Option('Delete the old spelling, its barrel export and every call site in the same change; the compile error is how callers get migrated.', true),
        new Option('If the old and new spellings genuinely differ in behaviour, they are two things: rename so neither reads as the other\'s replacement.'),
    ];
    readonly settings: Readonly<Record<string, FieldDef>> = {};
    readonly seed = Object.assign(new ConfigObject(), { mode: 'NEW_AND_MODIFIED_CODE' });

    check(file: LocalRuleFile): readonly LocalRuleFinding[] {
        const findings: LocalRuleFinding[] = [];
        const seen = new Set<number>();
        const visit = (node: ts.Node): void => {
            for (const tag of ts.getJSDocTags(node)) {
                if (tag.tagName.text !== 'deprecated' || seen.has(tag.pos)) continue;
                // TypeScript starts a tag at ANY @word after whitespace, so prose that merely mentions
                // the tag mid-sentence parses as one. Only a tag that opens its own JSDoc line is real.
                if (!this.opensItsLine(file.text, tag.getStart(file.source))) continue;
                seen.add(tag.pos);
                const line = file.lineOf(tag);
                findings.push(new LocalRuleFinding(line, line,
                    'A deprecated tag keeps the old spelling compiling, so no caller is ever migrated.'));
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return findings;
    }

    private opensItsLine(text: string, tagStart: number): boolean {
        const lineStart = text.lastIndexOf('\n', tagStart - 1) + 1;
        return /^\s*(\/\*\*|\*)?\s*$/.test(text.slice(lineStart, tagStart));
    }
}
