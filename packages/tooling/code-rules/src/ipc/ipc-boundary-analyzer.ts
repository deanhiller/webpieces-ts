/**
 * `ipc-boundary` judgement (#1389): one file, its syntax tree only. Ports the boundary half of the
 * consumer script's `inspectProgram` — the part that answered "nobody else may":
 *
 *   - `@webpieces/ipc-bridge` is imported, and its factories are built and called, only in composition files;
 *   - raw `IpcConnection` / `IpcRequest` / `IpcSuccess` / `IpcFailure` / `IpcTransport` are imported outside
 *     transport/composition files by nobody, constructed and driven (`request`, `setHandler`, `subscribe`,
 *     `send`) only in transport files;
 *   - raw WebView delivery (`injectJavaScript`, a WebView `postMessage`, destructuring either off a WebView)
 *     happens only in transport (or bootstrap) files, and a transport module's raw functions are imported
 *     only where they may be called;
 *   - retired modules, retired identifiers, handwritten wire-client class names and test-only scaffolding
 *     imports are refused everywhere; transport/bootstrap files author no legacy wire constant or command.
 *
 * The script resolved every alias with the checker. Here an alias is followed INSIDE the file — an import
 * rename, `const F = IpcClientFactory`, `const alias = webView`, a declaration typed with an imported
 * framework class — which is what a feature file would have to write to reach any of these, since every
 * route in starts with an import this rule sees.
 */

import * as ts from 'typescript';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { IpcBoundaryConfig } from '../configs/ipc-configs';
import { IpcFinding, IpcImportBinding, IpcModuleResolver, IpcSourceFile } from './ipc-source';

/** The framework's own vocabulary — webpieces' ipc-bridge surface, not consumer configuration. */
export class IpcFrameworkNames {
    static readonly BRIDGE_MODULE = '@webpieces/ipc-bridge';
    static readonly CORE_IPC_MODULE = '@webpieces/core-util/ipc';
    static readonly WEBVIEW_MODULE = 'react-native-webview';
    static readonly FACTORY_CLASSES: readonly string[] = ['IpcClientFactory', 'IpcServerFactory'];
    static readonly RAW_TYPES: readonly string[] = ['IpcConnection', 'IpcRequest', 'IpcSuccess', 'IpcFailure', 'IpcTransport'];
    static readonly RAW_CONSTRUCTIBLE: readonly string[] = ['IpcConnection', 'IpcRequest', 'IpcSuccess', 'IpcFailure'];
    static readonly FACTORY_METHODS: readonly string[] = ['createClient', 'create', 'createScoped', 'withContext'];
    static readonly CONNECTION_METHODS: readonly string[] = ['request', 'setHandler', 'subscribe', 'send'];
    static readonly TRANSPORT_RAW_EXPORTS: readonly string[] = ['request', 'send', 'notify', 'sendLegacy'];
    static readonly WEBVIEW_RAW_MEMBERS: readonly string[] = ['postMessage', 'injectJavaScript'];
    static readonly WEBVIEW_RECEIVER = /ReactNativeWebView|web[Vv]iew/;
}

const N = IpcFrameworkNames;

/** Why a site is refused. One spelling per reason, so a report groups cleanly. */
export class IpcBoundaryReasons {
    static readonly COMPOSITION =
        'Use an injected shared directional API. Only registered composition modules may create framework IPC ' +
        'clients/receivers; only registered transport modules may send raw messages.';
    static readonly TEST_SUPPORT = 'Production code cannot import test-only IPC scaffolding.';
    static readonly RETIRED_MODULE =
        'This module is retired from the IPC boundary. Protocol discovery uses only the bounded bootstrap envelope.';
    static readonly RETIRED_IDENTIFIER = 'This raw IPC helper is retired; inject the generated shared API client.';
    static readonly HANDWRITTEN_CLIENT =
        'Handwritten directional wire clients are retired; inject the generated shared API client.';
    static readonly LEGACY_CONSTANT =
        'Only protocol bootstrap may use the raw discovery operation; feature wire constants are forbidden in IPC infrastructure.';
    static readonly LEGACY_COMMAND = 'Do not author legacy feature wire commands in IPC infrastructure.';
}

const R = IpcBoundaryReasons;

/** What a local name is known to hold. */
enum Origin {
    FACTORY = 'factory',
    CONNECTION = 'connection',
    TRANSPORT = 'transport',
    WEBVIEW = 'webview',
}

/** Which privileged role the judged file plays. Data-only. */
export class IpcFileRole {
    constructor(
        readonly transport: boolean,
        readonly composition: boolean,
        readonly bootstrap: boolean,
    ) {}
}

/** The boundary config, compiled once per run. */
export class IpcBoundaryPolicy {
    readonly classPatterns: readonly RegExp[];

    constructor(
        readonly config: IpcBoundaryConfig,
        /** The exported constants of `legacyWireFile` (empty when it is null). */
        readonly legacyNames: ReadonlySet<string>,
    ) {
        this.classPatterns = config.forbiddenClassNamePatterns.map((pattern: string) => new RegExp(pattern));
    }

    roleOf(relFile: string): IpcFileRole {
        const transport = matchesAnyGlob(relFile, this.config.transportFiles);
        const composition = transport || matchesAnyGlob(relFile, this.config.compositionFiles);
        return new IpcFileRole(transport, composition, matchesAnyGlob(relFile, this.config.bootstrapFiles));
    }

    isTransportFile(relFile: string): boolean {
        return matchesAnyGlob(relFile, this.config.transportFiles);
    }
}

/** Per-file knowledge: which local names are framework classes, and what each tracked name holds. */
class FileFacts {
    readonly classAliases = new Map<string, string>();
    readonly namespaces = new Map<string, string>();
    readonly transportImports = new Set<string>();
    readonly webviewTypes = new Set<string>();
    readonly origins = new Map<string, Origin>();
}

export class IpcBoundaryAnalyzer {
    constructor(
        private readonly policy: IpcBoundaryPolicy,
        private readonly resolver: IpcModuleResolver,
    ) {}

    analyze(file: IpcSourceFile): IpcFinding[] {
        const role = this.policy.roleOf(file.relFile);
        const facts = this.factsOf(file);
        const findings: IpcFinding[] = [];
        for (const binding of file.imports()) findings.push(...this.judgeBinding(file, binding, role));
        const visit = (node: ts.Node): void => {
            findings.push(...this.judgeNode(file, node, role, facts));
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        const seen = new Set<string>();
        return findings.filter((finding: IpcFinding) => {
            const key = `${finding.line}\u0000${finding.message}\u0000${finding.snippet}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private factsOf(file: IpcSourceFile): FileFacts {
        const facts = new FileFacts();
        for (const binding of file.imports()) this.learnImport(file, binding, facts);
        // Two passes so an alias of an alias (`const a = webView; const b = a;`) is followed.
        for (let pass = 0; pass < 2; pass++) {
            const visit = (node: ts.Node): void => {
                this.learnDeclaration(node, facts);
                ts.forEachChild(node, visit);
            };
            visit(file.source);
        }
        return facts;
    }

    private learnImport(file: IpcSourceFile, binding: IpcImportBinding, facts: FileFacts): void {
        const framework = binding.moduleSpecifier === N.BRIDGE_MODULE || binding.moduleSpecifier === N.CORE_IPC_MODULE;
        if (framework && binding.imported === '*') facts.namespaces.set(binding.local, binding.moduleSpecifier);
        if (framework && (N.FACTORY_CLASSES.includes(binding.imported) || N.RAW_TYPES.includes(binding.imported))) {
            facts.classAliases.set(binding.local, binding.imported);
        }
        if (binding.moduleSpecifier === N.WEBVIEW_MODULE) facts.webviewTypes.add(binding.local);
        const target = this.resolver.resolve(file.relFile, binding.moduleSpecifier);
        if (target === undefined || !this.policy.isTransportFile(target)) return;
        if (binding.imported === '*') facts.origins.set(binding.local, Origin.TRANSPORT);
        else facts.transportImports.add(binding.local);
    }

    private learnDeclaration(node: ts.Node, facts: FileFacts): void {
        const declared =
            ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) ? node : undefined;
        if (declared === undefined || !ts.isIdentifier(declared.name)) return;
        const name = declared.name.text;
        const initializer = declared.initializer === undefined ? undefined : this.unwrap(declared.initializer);
        if (initializer !== undefined && ts.isIdentifier(initializer)) {
            const aliased = facts.classAliases.get(initializer.text);
            if (aliased !== undefined) facts.classAliases.set(name, aliased);
        }
        const origin = this.originOfType(declared.type, facts) ?? this.originOfValue(initializer, facts);
        if (origin !== undefined) facts.origins.set(name, origin);
    }

    private originOfType(type: ts.TypeNode | undefined, facts: FileFacts): Origin | undefined {
        if (type === undefined || !ts.isTypeReferenceNode(type)) return undefined;
        const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
        return this.originOfClassName(name, facts);
    }

    private originOfClassName(name: string, facts: FileFacts): Origin | undefined {
        const known = N.FACTORY_CLASSES.includes(name) || N.RAW_TYPES.includes(name);
        const framework = facts.classAliases.get(name) ?? (known ? name : undefined);
        if (framework !== undefined && N.FACTORY_CLASSES.includes(framework)) return Origin.FACTORY;
        if (framework === 'IpcConnection') return Origin.CONNECTION;
        if (facts.transportImports.has(name)) return Origin.TRANSPORT;
        if (facts.webviewTypes.has(name)) return Origin.WEBVIEW;
        return undefined;
    }

    private originOfValue(value: ts.Expression | undefined, facts: FileFacts): Origin | undefined {
        if (value === undefined) return undefined;
        if (ts.isNewExpression(value)) {
            const constructed = this.constructedName(value, facts);
            return constructed === undefined ? undefined : this.originOfClassName(constructed, facts);
        }
        const tracked = this.originOfReceiver(value, facts);
        if (tracked !== undefined) return tracked;
        return N.WEBVIEW_RECEIVER.test(value.getText()) ? Origin.WEBVIEW : undefined;
    }

    /** What `expr` holds when it is a tracked name, `this.<tracked>`, or a namespace import. */
    private originOfReceiver(expr: ts.Expression, facts: FileFacts): Origin | undefined {
        const node = this.unwrap(expr);
        if (ts.isIdentifier(node)) return facts.origins.get(node.text);
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
            return facts.origins.get(node.name.text);
        }
        return undefined;
    }

    /** The framework/transport class a `new` builds, through import renames, aliases and namespaces. */
    private constructedName(node: ts.NewExpression, facts: FileFacts): string | undefined {
        const callee = this.unwrap(node.expression);
        if (ts.isIdentifier(callee)) return facts.classAliases.get(callee.text) ?? callee.text;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
            if (facts.namespaces.has(callee.expression.text)) return callee.name.text;
        }
        return undefined;
    }

    private judgeBinding(file: IpcSourceFile, binding: IpcImportBinding, role: IpcFileRole): IpcFinding[] {
        const out: IpcFinding[] = [];
        const isCoreRaw = binding.moduleSpecifier === N.CORE_IPC_MODULE && N.RAW_TYPES.includes(binding.imported);
        if (isCoreRaw && !role.transport && !role.composition) out.push(file.finding(binding.node, R.COMPOSITION));
        const target = this.resolver.resolve(file.relFile, binding.moduleSpecifier);
        if (target !== undefined && this.policy.isTransportFile(target) && !role.bootstrap) {
            const raw = N.TRANSPORT_RAW_EXPORTS.includes(binding.imported) && !role.transport;
            const client = binding.imported === 'createClient' && !role.composition;
            if (raw || client) out.push(file.finding(binding.node, R.COMPOSITION));
        }
        const legacy = this.policy.legacyNames.has(binding.imported) && !binding.typeOnly;
        const allowed = role.bootstrap && this.policy.config.bootstrapAllowedLegacyNames.includes(binding.imported);
        if (legacy && (role.transport || role.bootstrap) && !allowed) out.push(file.finding(binding.node, R.LEGACY_CONSTANT));
        return out;
    }

    private judgeNode(file: IpcSourceFile, node: ts.Node, role: IpcFileRole, facts: FileFacts): IpcFinding[] {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return this.judgeModuleDeclaration(file, node, role);
        if (ts.isCallExpression(node)) return this.judgeDynamicLoad(file, node, role);
        if (ts.isClassDeclaration(node)) return this.judgeClassName(file, node);
        if (ts.isNewExpression(node)) return this.judgeConstruction(file, node, role, facts);
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            return this.judgeMember(file, node, role, facts);
        }
        if (ts.isBindingElement(node)) return this.judgeDestructure(file, node, role, facts);
        if (ts.isIdentifier(node) && this.policy.config.retiredIdentifiers.includes(node.text)) {
            return [file.finding(node, R.RETIRED_IDENTIFIER)];
        }
        if ((role.transport || role.bootstrap) && ts.isStringLiteral(node)) return this.judgeLegacyCommand(file, node);
        return [];
    }

    private judgeModuleDeclaration(
        file: IpcSourceFile,
        node: ts.ImportDeclaration | ts.ExportDeclaration,
        role: IpcFileRole,
    ): IpcFinding[] {
        const specifierNode = node.moduleSpecifier;
        if (specifierNode === undefined || !ts.isStringLiteral(specifierNode)) return [];
        const specifier = specifierNode.text;
        const out: IpcFinding[] = [];
        if (this.policy.config.testOnlyModuleSuffixes.some((suffix: string) => this.endsWithModule(specifier, suffix))) {
            out.push(file.finding(node, R.TEST_SUPPORT));
        }
        if (this.policy.config.retiredModules.includes(specifier)) out.push(file.finding(node, R.RETIRED_MODULE));
        if (specifier === N.BRIDGE_MODULE && !role.composition) out.push(file.finding(node, R.COMPOSITION));
        return out;
    }

    private endsWithModule(specifier: string, suffix: string): boolean {
        return specifier.endsWith(suffix) || specifier.endsWith(`${suffix}.js`) || specifier.endsWith(`${suffix}.ts`);
    }

    private judgeDynamicLoad(file: IpcSourceFile, node: ts.CallExpression, role: IpcFileRole): IpcFinding[] {
        const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        const first = node.arguments[0];
        if (!loader || first === undefined || !ts.isStringLiteralLike(first)) return [];
        if (this.policy.config.retiredModules.includes(first.text)) return [file.finding(node, R.RETIRED_MODULE)];
        if (first.text === N.BRIDGE_MODULE && !role.composition) return [file.finding(node, R.COMPOSITION)];
        return [];
    }

    private judgeClassName(file: IpcSourceFile, node: ts.ClassDeclaration): IpcFinding[] {
        const name = node.name?.text;
        if (name === undefined) return [];
        const refused = this.policy.classPatterns.some((pattern: RegExp) => pattern.test(name));
        return refused ? [file.finding(node.name ?? node, R.HANDWRITTEN_CLIENT)] : [];
    }

    private judgeConstruction(file: IpcSourceFile, node: ts.NewExpression, role: IpcFileRole, facts: FileFacts): IpcFinding[] {
        const name = this.constructedName(node, facts);
        if (name === undefined) return [];
        if (N.FACTORY_CLASSES.includes(name) && !role.composition) return [file.finding(node, R.COMPOSITION)];
        if (N.RAW_CONSTRUCTIBLE.includes(name) && !role.transport) return [file.finding(node, R.COMPOSITION)];
        return [];
    }

    private judgeMember(
        file: IpcSourceFile,
        node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        role: IpcFileRole,
        facts: FileFacts,
    ): IpcFinding[] {
        const member = this.memberName(node);
        if (member === undefined) return [];
        const origin = this.originOfReceiver(node.expression, facts);
        const webview = origin === Origin.WEBVIEW || N.WEBVIEW_RECEIVER.test(node.expression.getText());
        const rawDelivery = member === 'injectJavaScript' || (member === 'postMessage' && webview);
        if (rawDelivery && !role.transport && !role.bootstrap) return [file.finding(node, R.COMPOSITION)];
        if (origin === Origin.FACTORY && N.FACTORY_METHODS.includes(member) && !role.composition) {
            return [file.finding(node, R.COMPOSITION)];
        }
        if (origin === Origin.CONNECTION && N.CONNECTION_METHODS.includes(member) && !role.transport) {
            return [file.finding(node, R.COMPOSITION)];
        }
        if (origin === Origin.TRANSPORT && !role.bootstrap) {
            const raw = N.TRANSPORT_RAW_EXPORTS.includes(member) && !role.transport;
            const client = member === 'createClient' && !role.composition;
            if (raw || client) return [file.finding(node, R.COMPOSITION)];
        }
        return [];
    }

    private memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
        if (ts.isPropertyAccessExpression(node)) return node.name.text;
        return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    }

    private judgeDestructure(file: IpcSourceFile, node: ts.BindingElement, role: IpcFileRole, facts: FileFacts): IpcFinding[] {
        if (role.transport) return [];
        const key = node.propertyName ?? node.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
        if (name === undefined || !N.WEBVIEW_RAW_MEMBERS.includes(name)) return [];
        const declaration = node.parent.parent;
        if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return [];
        const source = declaration.initializer;
        const webview = this.originOfReceiver(source, facts) === Origin.WEBVIEW || N.WEBVIEW_RECEIVER.test(source.getText());
        return webview ? [file.finding(node, R.COMPOSITION)] : [];
    }

    private judgeLegacyCommand(file: IpcSourceFile, node: ts.StringLiteral): IpcFinding[] {
        const legacy = this.policy.config.legacyWireCommandPrefixes.some((prefix: string) => node.text.startsWith(prefix));
        return legacy ? [file.finding(node, R.LEGACY_COMMAND)] : [];
    }

    private unwrap(expr: ts.Expression): ts.Expression {
        let node = expr;
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
            node = node.expression;
        }
        return node;
    }
}
