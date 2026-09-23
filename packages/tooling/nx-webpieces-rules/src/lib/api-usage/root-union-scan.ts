/**
 * `no-root-union-api-type` — REFUSE a request or response type that IS a union.
 *
 * ## Why this breaks the build instead of being a lint warning
 *
 * Both the OpenAI and the Anthropic function-calling APIs forbid `oneOf`/`anyOf`/`allOf` at the TOP
 * LEVEL of a tool's parameter schema. A server sends its WHOLE tool list on every request, so ONE
 * offending tool makes EVERY request return HTTP 400 — the entire client session is bricked, not
 * just that tool, and the symptom a user reports is that every OTHER tool stopped working. It
 * usually arrives by accident: an SDK turns a discriminated union at the root into `{oneOf: [...]}`.
 * Live reports: imagekit-developer/imagekit-nodejs#150, posthog/posthog#61359, vercel/ai#21350,
 * opentokenz/mcpx#28.
 *
 * NESTED composition — a union inside a property — is perfectly fine and is published as `oneOf`
 * with its derived discriminator (#1009). Only the ROOT is the problem.
 *
 * ## Why it lives in the RULES ENGINE and not in the doc parser
 *
 * `@webpieces/api-doc-model` only ever visits contracts that declare `@ApiType`, so a rule
 * implemented there could not — by construction — enforce anything on contracts that have not opted
 * in yet, which is exactly the population this rule exists to protect. `@ApiType` is a PUBLISHING
 * decision added later, on purpose; if the shape rules do not hold from the first line, then adding
 * the annotation becomes a migration nobody expects, on a type already in partners' generated
 * clients. The scan below walks EVERY `@ApiPath` contract in the workspace, `@ApiType` or not.
 *
 * ## Why it is PARSER-ONLY
 *
 * Same reason `ApiSourceIndexBuilder` is: a plain parse cannot be diverted to a decorator-erased
 * `.d.ts` by module resolution, and it is cheap enough to run over every project. The cost is that a
 * union alias declared in a package this workspace does not build is invisible — the same blind spot
 * every other check in this directory has, and the same one `recoverFromDeclaration` documents.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    loadAndValidate,
    matchesAnyGlob,
    WEBPIECES_DISABLE,
    RULE_NAMES,
} from '@webpieces/rules-config';
import { ProjectInfo } from '../project-info';
import { RuleGate } from '../rule-gate';
import {
    collectTsFiles,
    hasClassDecorator,
    isAbstractClass,
    isTestFile,
    memberDecorator,
    typeReferenceName,
} from './api-ast';

/** The rule name, as it is written in a disable comment and as a config key. */
export const ROOT_UNION_RULE = RULE_NAMES.NO_ROOT_UNION_API_TYPE;

/**
 * `// webpieces-disable no-root-union-api-type -- <reason>`, with the reason CAPTURED so a
 * reasonless one can be told apart from an absent one. A comma list of rules is the shared spelling
 * (`disable-directives.ts`), so it is accepted here too.
 */
const DISABLE_RE = new RegExp(
    `//\\s*${WEBPIECES_DISABLE}\\s+([\\w-]+(?:\\s*,\\s*[\\w-]+)*)(?:\\s*--\\s*(.*))?$`,
);

/**
 * The rule's SWITCHES, resolved from webpieces.config.json once per scan.
 *
 * Read here, not inside the scan, so a unit test constructs the scan with explicit values and never
 * touches a config file — and so the config is read exactly once per executor run, beside the
 * `externalApiPaths` read that already happens there.
 */
export class RootUnionRule {
    constructor(
        public readonly enabled: boolean,
        /** Project roots this rule does not apply to — `allowedPaths` in the config. */
        public readonly allowedPaths: readonly string[],
    ) {}

    /**
     * The DEFAULT: armed, everywhere. A rule entry that is absent means RUN — never invent a default
     * that silently disables a check (the same rule `RuleGate` states for the nx validators).
     */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static enabledEverywhere(): RootUnionRule {
        return new RootUnionRule(true, []);
    }

    /** `mode: OFF` and the time-box/branch hatches come from RuleGate, so there is ONE reading of them. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromConfig(workspaceRoot: string): RootUnionRule {
        if (new RuleGate().isDisabled(workspaceRoot, ROOT_UNION_RULE, true)) {
            return new RootUnionRule(false, []);
        }
        const rule = loadAndValidate(workspaceRoot).resolved.rules.get(ROOT_UNION_RULE);
        const allowed = rule?.options['allowedPaths'];
        return new RootUnionRule(true, Array.isArray(allowed) ? (allowed as string[]) : []);
    }
}

/** ONE contract method whose request or response type is ITSELF a union. */
export class RootUnionApiType {
    constructor(
        /** The `@ApiPath` contract class. */
        public readonly api: string,
        /** The `@Endpoint` method on it. */
        public readonly method: string,
        /** `request` or `response` — which side carries the union. */
        public readonly side: string,
        /** The union type's NAME, as written on the method. */
        public readonly typeName: string,
        /** `path/to/File.ts:LINE`, workspace-relative. */
        public readonly at: string,
        /** True when a disable comment names this rule but gives NO reason. */
        public readonly disabledWithoutReason: boolean,
    ) {}
}

/** What one scan found. Two lists because the two have different cures. */
export class RootUnionFindings {
    constructor(
        /** Root-level unions with no disable at all. */
        public readonly violations: readonly RootUnionApiType[],
        /**
         * Sites that DID carry a disable for this rule and gave no reason. A reasonless disable is
         * itself a violation: the blast radius here is every tool in a session, so a suppression has
         * to carry an argument somebody wrote down and the next reader can weigh.
         */
        public readonly reasonlessDisables: readonly RootUnionApiType[],
    ) {}

    isEmpty(): boolean {
        return this.violations.length === 0 && this.reasonlessDisables.length === 0;
    }
}

/** One `type X = A | B` alias found in the workspace, keyed in the index by its NAME. */
class UnionAlias {
    constructor(
        public readonly name: string,
        /** The branch type names, in declaration order. */
        public readonly branches: readonly string[],
    ) {}
}

/** One `@Endpoint` method's declared request/response type names, with where to point an author. */
class EndpointTypes {
    constructor(
        public readonly api: string,
        public readonly method: string,
        public readonly requestType: string | null,
        public readonly responseType: string | null,
        public readonly at: string,
        /** The declaration's own lines, decorators included — where a disable comment may sit. */
        public readonly declarationText: string,
    ) {}
}

/**
 * Walks every project's `src/**` once, indexing union aliases and contract methods, then joins the
 * two. One pass, because the alias and the contract that uses it are routinely in different files
 * and often in different projects.
 */
export class RootUnionScan {
    private readonly aliases = new Map<string, UnionAlias>();
    private readonly endpoints: EndpointTypes[] = [];
    /** Alias name -> the disable comment written on its declaration, when it carries one. */
    private readonly aliasDisables = new Map<string, DisableComment>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly projectInfos: Map<string, ProjectInfo>,
        /** The rule's switches. ARMED unless a caller read otherwise out of webpieces.config.json. */
        private readonly rule: RootUnionRule = RootUnionRule.enabledEverywhere(),
    ) {}

    run(): RootUnionFindings {
        if (!this.rule.enabled) return new RootUnionFindings([], []);
        for (const info of this.projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            if (matchesAnyGlob(info.root, this.rule.allowedPaths)) continue;
            this.indexProject(info);
        }
        const violations: RootUnionApiType[] = [];
        const reasonless: RootUnionApiType[] = [];
        for (const endpoint of this.endpoints) {
            this.judge(endpoint, 'request', endpoint.requestType, violations, reasonless);
            this.judge(endpoint, 'response', endpoint.responseType, violations, reasonless);
        }
        return new RootUnionFindings(violations, reasonless);
    }

    /** One side of one method: a union type name is a violation unless a REASONED disable covers it. */
    private judge(
        endpoint: EndpointTypes,
        side: string,
        typeName: string | null,
        violations: RootUnionApiType[],
        reasonless: RootUnionApiType[],
    ): void {
        if (typeName === null || !this.aliases.has(typeName)) return;
        // Either the method or the alias may carry the disable: the method is the site that
        // PUBLISHES the shape, and the alias is the declaration somebody will be looking at when
        // they decide the shape is deliberate. Both are "the offending declaration".
        const disable =
            DisableComment.readFrom(endpoint.declarationText) ?? this.aliasDisables.get(typeName);
        const found = new RootUnionApiType(
            endpoint.api,
            endpoint.method,
            side,
            typeName,
            endpoint.at,
            disable !== undefined && !disable.hasReason,
        );
        if (disable === undefined) {
            violations.push(found);
            return;
        }
        if (!disable.hasReason) reasonless.push(found);
    }

    private indexProject(info: ProjectInfo): void {
        const srcDir = path.join(path.resolve(this.workspaceRoot, info.root), 'src');
        if (!fs.existsSync(srcDir)) return;
        for (const file of collectTsFiles(srcDir)) {
            if (isTestFile(file)) continue; // a fixture is not a published contract
            const text = fs.readFileSync(file, 'utf8');
            const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            this.indexNode(sourceFile, sourceFile);
        }
    }

    private indexNode(node: ts.Node, sourceFile: ts.SourceFile): void {
        if (ts.isTypeAliasDeclaration(node)) this.indexAlias(node, sourceFile);
        if (ts.isClassDeclaration(node)) this.indexContract(node, sourceFile);
        ts.forEachChild(node, (child: ts.Node) => this.indexNode(child, sourceFile));
    }

    /**
     * `type X = A | B` where at least two branches are NAMED types.
     *
     * A union of string literals (`type Phase = 'placed' | 'done'`) is deliberately NOT one: it
     * publishes as `enum`, which is a scalar and carries no `oneOf` at all. `| null` / `| undefined`
     * branches are dropped for the same reason the doc model drops them — they are nullability, not
     * composition.
     */
    private indexAlias(alias: ts.TypeAliasDeclaration, sourceFile: ts.SourceFile): void {
        if (!ts.isUnionTypeNode(alias.type)) return;
        const branches: string[] = [];
        for (const branch of alias.type.types) {
            if (RootUnionScan.isNullish(branch)) continue;
            const named = typeReferenceName(branch);
            if (named === null) return; // not a composition of named object types
            branches.push(named);
        }
        if (branches.length < 2) return;
        const name = alias.name.text;
        this.aliases.set(name, new UnionAlias(name, branches));
        const disable = DisableComment.readFrom(RootUnionScan.textOf(alias, sourceFile));
        if (disable !== undefined) this.aliasDisables.set(name, disable);
    }

    // webpieces-disable no-function-outside-class -- private static predicate of this class
    private static isNullish(node: ts.TypeNode): boolean {
        if (
            node.kind === ts.SyntaxKind.UndefinedKeyword ||
            node.kind === ts.SyntaxKind.NullKeyword
        ) {
            return true;
        }
        return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
    }

    /** Every `@Endpoint` method of an `abstract class` carrying `@ApiPath` — `@ApiType` or not. */
    private indexContract(cls: ts.ClassDeclaration, sourceFile: ts.SourceFile): void {
        if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return;
        const api = cls.name.text;
        for (const member of cls.members) {
            if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
            if (memberDecorator(member, 'Endpoint') === null) continue;
            this.endpoints.push(
                new EndpointTypes(
                    api,
                    member.name.text,
                    typeReferenceName(member.parameters[0]?.type),
                    RootUnionScan.awaitedName(member.type),
                    this.locate(member, sourceFile),
                    RootUnionScan.textOf(member, sourceFile),
                ),
            );
        }
    }

    /** `Promise<T>` -> `T`'s name; a bare `T` is read as itself, so both spellings are covered. */
    // webpieces-disable no-function-outside-class -- private static accessor of this class
    private static awaitedName(declared: ts.TypeNode | undefined): string | null {
        if (declared === undefined || !ts.isTypeReferenceNode(declared)) return null;
        const outer = typeReferenceName(declared);
        if (outer !== 'Promise') return outer;
        const args = declared.typeArguments ?? [];
        return args.length === 1 ? typeReferenceName(args[0]) : null;
    }

    /**
     * The declaration's own source text INCLUDING its leading trivia, so a disable comment written
     * on the line above the first decorator is part of what is read.
     */
    // webpieces-disable no-function-outside-class -- private static accessor of this class
    private static textOf(node: ts.Node, sourceFile: ts.SourceFile): string {
        return sourceFile.text.slice(node.getFullStart(), node.getEnd());
    }

    private locate(node: ts.Node, sourceFile: ts.SourceFile): string {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        return `${path.relative(this.workspaceRoot, sourceFile.fileName)}:${position.line + 1}`;
    }
}

/** ONE `webpieces-disable` naming this rule, and whether it gave a reason. */
class DisableComment {
    constructor(public readonly hasReason: boolean) {}

    /** The FIRST disable naming this rule in `text`, or undefined when it names none. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static readFrom(text: string): DisableComment | undefined {
        for (const line of text.split('\n')) {
            const match = line.match(DISABLE_RE);
            if (match === null) continue;
            const named = match[1].split(',').map((each: string): string => each.trim());
            if (!named.includes(ROOT_UNION_RULE)) continue;
            return new DisableComment((match[2] ?? '').trim() !== '');
        }
        return undefined;
    }
}
