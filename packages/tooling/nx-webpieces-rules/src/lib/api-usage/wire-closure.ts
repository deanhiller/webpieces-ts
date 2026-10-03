/**
 * The WIRE CLOSURE of a contract (#1064, D4): every named type an `@ApiPath` contract reaches must be
 * DECLARED in a `role:api-lib` project, and must end in a suffix that project's `required-type-suffix`
 * entry demands.
 *
 * Why it lives here and not in the dependency rule: `api-lib-dependencies` only sees project EDGES. A
 * relative-path import into another library, or a DTO library that itself reaches outside, puts a type
 * on the wire without any edge the graph rule could refuse. The extractor already follows every type a
 * contract reaches through the compiler — the same walk `api-rules-for-openapi` / `api-rules-for-mcp`
 * run, with no generate tag needed — so this is one more question asked of each type that walk found.
 *
 * Every api-lib rule before this one (`required-type-suffix`, `one-enum-spelling-in-api-lib`,
 * `no-utility-types-in-api-lib`, `no-inline-import-in-api-lib`) reads only source files INSIDE the api
 * library. A type declared in another package was, by construction, outside every one of them — which is
 * how `AiProvider` and the `BrowserTelemetry` trio reached the wire from a general library unchecked.
 *
 * A type declared OUTSIDE the workspace (a published package under node_modules) is not judged here:
 * its own package owns its schema, and the generator's fail-closed components check covers it.
 */

import * as path from 'path';
import { DocumentedType } from '@webpieces/api-doc-model';
import { SuffixEntryPicker } from '@webpieces/code-rules';
import { loadAndValidate } from "@webpieces/rules-config";
import { RequiredTypeSuffixEntry } from "@webpieces/code-rules";
import { ProjectInfo } from '../project-info';
import { resolveRole } from '../role-resolver';
import { RuleGate } from '../rule-gate';

const API_LIB_ROLE = 'api-lib';

/** The `required-type-suffix` entries the wire closure enforces; empty when that rule is OFF. */
export class WireClosureRule {
    constructor(public readonly suffixEntries: readonly RequiredTypeSuffixEntry[]) {}

    /** Only the role check — what a unit test or a repo with `required-type-suffix` OFF gets. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static withoutSuffixes(): WireClosureRule {
        return new WireClosureRule([]);
    }

    /** `required-type-suffix`'s entries, unless that rule is OFF or time-boxed / branch-scoped off. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromConfig(workspaceRoot: string): WireClosureRule {
        if (new RuleGate().skipReason(workspaceRoot, "required-type-suffix", true) !== null) {
            return WireClosureRule.withoutSuffixes();
        }
        const rule = loadAndValidate(workspaceRoot).resolved.rules.get("required-type-suffix");
        const entries = rule?.options['entries'];
        return new WireClosureRule(Array.isArray(entries) ? (entries as RequiredTypeSuffixEntry[]) : []);
    }
}

/** ONE wire-closure finding: what is wrong with a reached type, and what to do. */
export class WireClosureVerdict {
    constructor(
        public readonly what: string,
        public readonly cure: string,
    ) {}
}

/** A workspace project root, absolute, for the longest-prefix owner lookup. */
class OwnedRoot {
    constructor(
        public readonly info: ProjectInfo,
        public readonly abs: string,
    ) {}
}

/** Judges every type a contract reaches against the api-lib role and the suffix rule. */
export class WireClosure {
    private readonly roots: OwnedRoot[];
    private readonly picker = new SuffixEntryPicker();

    constructor(
        private readonly workspaceRoot: string,
        projectInfos: Map<string, ProjectInfo>,
        private readonly rule: WireClosureRule,
    ) {
        this.roots = [...projectInfos.values()]
            .filter((info: ProjectInfo) => info.root !== '' && info.root !== '.')
            .map((info: ProjectInfo) => new OwnedRoot(info, path.resolve(workspaceRoot, info.root)))
            // Longest root first so a nested project wins over its parent.
            .sort((a: OwnedRoot, b: OwnedRoot) => b.abs.length - a.abs.length);
    }

    /** Every verdict for ONE reached type, declared in the file `absFile`. */
    judge(type: DocumentedType, absFile: string): WireClosureVerdict[] {
        const abs = path.resolve(this.workspaceRoot, absFile);
        if (abs.split(path.sep).includes('node_modules')) return [];
        const owner = this.ownerOf(abs);
        if (owner === null) return [];
        const relFile = path.relative(this.workspaceRoot, abs).split(path.sep).join('/');
        const role = resolveRole(owner).role ?? 'none';
        const declared = `${type.packageName ?? 'no package'} (project '${owner.name}', role:${role})`;
        const verdicts: WireClosureVerdict[] = [];
        if (role !== API_LIB_ROLE) {
            verdicts.push(new WireClosureVerdict(
                `'${type.name}' goes over the wire but is declared in ${declared}, which is not a role:api-lib ` +
                    'project — every type a contract reaches must be declared in an api library',
                `Move '${type.name}' into a role:api-lib project — as a '…Dto' string enum when it is a ` +
                    `string-literal union. Retagging '${owner.name}' is not a way out unless it holds only ` +
                    'contracts and wire types (validate-api-lib-tag refuses a role:api-lib with an implementation).',
            ));
        }
        const governing = this.picker.winner(relFile, this.rule.suffixEntries);
        if (governing !== undefined && !this.endsInSuffix(type.name, governing.entry.suffixes)) {
            verdicts.push(new WireClosureVerdict(
                `'${type.name}' goes over the wire from ${relFile} but does not end in one of ` +
                    `[${governing.entry.suffixes.join(', ')}], which the required-type-suffix entry ` +
                    `'${governing.glob}' demands of it`,
                `Rename '${type.name}' to end in one of ${governing.entry.suffixes.join(', ')} — the suffix tells a ` +
                    'reader which layer a type belongs to, and a wire type is the layer a partner reads.',
            ));
        }
        return verdicts;
    }

    private endsInSuffix(name: string, suffixes: readonly string[]): boolean {
        return suffixes.some((suffix: string) => name.length > suffix.length && name.endsWith(suffix));
    }

    private ownerOf(abs: string): ProjectInfo | null {
        for (const root of this.roots) {
            if (abs === root.abs || abs.startsWith(root.abs + path.sep)) return root.info;
        }
        return null;
    }
}
