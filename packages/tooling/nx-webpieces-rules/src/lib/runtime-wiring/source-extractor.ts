import * as path from 'path';
import * as ts from 'typescript';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ProjectInfo } from '../project-info';
import { createProjectProgram } from '../di-graph/program';
import {
    ContractIdentity,
    ImplementsFacts,
    UsesFacts,
    RuntimeDeclaration,
    WiringExport,
    WiringRelationship,
    WiringSelection,
} from './declaration';
import { WiringSourceValues } from './source-values';
import { WiringSourceTypes } from './source-types';
import type { WiringKind } from './source-types';
import * as fs from 'fs';

/** Build-only extraction. It never imports application modules or invokes their constructors. */
class WiringProjectMetadata {
    declare metadata?: WiringProjectMetadataValues;
}
class WiringProjectMetadataValues {
    declare webpieces?: WiringServiceMetadata;
}
class WiringServiceMetadata {
    declare serviceName?: string;
}

export class WiringSourceExtractor {
    private readonly values: WiringSourceValues;
    private readonly exported: Record<string, WiringExport> = {};
    private entry: string | undefined;
    private host: string | undefined;

    constructor(
        private readonly workspaceRoot: string,
        private readonly info: ProjectInfo,
        private readonly infos: ReadonlyMap<string, ProjectInfo>,
        private readonly program: ts.Program,
    ) {
        this.values = new WiringSourceValues(workspaceRoot, infos, program.getTypeChecker());
    }

    /**
     * Reads ONLY the owner's canonical src/wiring.ts. The program still type-checks every file so
     * imports, aliases and re-exports resolve, but no other file's body is visited for wiring facts:
     * a module declared elsewhere can neither add a relationship nor be discovered as a fallback.
     */
    extract(): RuntimeDeclaration {
        const wiring = this.program.getSourceFile(this.wiringPath);
        if (wiring === undefined) this.fail(`Missing canonical ${this.wiringPath}.`);
        for (const statement of wiring!.statements)
            if (ts.isClassDeclaration(statement)) this.recordWiring(statement);
        const framework = this.info.tags.includes('framework:angular')
            ? 'angular'
            : this.info.tags.some((tag) => tag === 'framework:node' || tag === 'framework:express')
              ? 'node'
              : 'browser';
        if (this.info.tags.includes('webpieces') && this.entry === undefined)
            this.fail(`${this.info.name} requires one unambiguous exported AppWiring in src/wiring.ts.`);
        return new RuntimeDeclaration(
            this.info.name,
            framework,
            this.exported,
            this.entry,
            this.host,
        );
    }

    /**
     * The registration forms that carry graph facts: binder.createRpcClientAndBind /
     * createPubSubClientAndBind / bindExternal and router.addRoutes (plus the factory calls they wrap).
     */
    private facts(node: ts.Node, owner: string): void {
        if (ts.isCallExpression(node) && this.frameworkCall(node)) {
            const name = this.values.symbolName(node.expression);
            if (name === 'bindExternal') this.recordExternal(node, owner);
            else if (['addRoutes', 'createRpcClient', 'createPubSubClient', 'createRpcClientAndBind', 'createPubSubClientAndBind'].includes(name))
                this.recordRelationship(node, name, owner);
        }
        ts.forEachChild(node, (child: ts.Node) => this.facts(child, owner));
    }

    /**
     * binder.bindExternal(Api, VendorImpl): the vendor contract's identity comes from the resolved
     * symbol, exactly like any other API. An APPLICATION owner must also prove a production business
     * consumer of it; a library module binds an adapter for whichever app selects it, so its
     * consumer lives in that app.
     */
    private recordExternal(call: ts.CallExpression, owner: string): void {
        const api = call.arguments[0];
        if (api === undefined || call.arguments[1] === undefined)
            this.fail('bindExternal requires the external API contract and its vendor implementation.');
        const contract = this.values.identity(api!);
        if (
            this.info.tags.includes('webpieces') &&
            !this.values.hasExternalConsumer(this.info.name, contract.project, contract.exportedName, this.program)
        )
            this.fail(
                `${contract.project}#${contract.exportedName} has no production business consumer in ${this.info.name}; adapters and test doubles do not establish uses.`,
            );
        const exported = this.exported[owner];
        exported.relationships.push(
            new WiringRelationship(
                contract,
                new UsesFacts('external', {
                    kind: 'unknown',
                    reason: 'Vendor interface; destination classified by approved contract metadata',
                }),
            ),
        );
        this.exported[owner] = exported;
    }

    private recordRelationship(call: ts.CallExpression, method: string, owner: string): void {
        const api = call.arguments[0];
        if (api === undefined) this.fail(`${method} requires an explicit API contract.`);
        const contract = this.values.identity(api!);
        const direction = method === 'addRoutes' ? 'implements' : 'uses';
        const contractTransport = this.values.transport(api!);
        const transport =
            method === 'addRoutes'
                ? contractTransport
                : method === 'createPubSubClientAndBind' || method === 'createPubSubClient'
                  ? 'pubsub'
                  : 'rpc';
        if (transport !== contractTransport)
            this.fail(
                `${method} transport disagrees with ${contract.project}#${contract.exportedName}.`,
            );
        const target =
            direction === 'implements'
                ? undefined
                : this.values.target(call.arguments[1]);
        const exported = this.exported[owner];
        exported.relationships.push(
            new WiringRelationship(
                contract,
                direction === 'implements'
                    ? new ImplementsFacts(transport, this.values.condition(call))
                    : new UsesFacts(transport, target!, this.values.condition(call)),
            ),
        );
        this.exported[owner] = exported;
    }

    private frameworkCall(call: ts.CallExpression): boolean {
        const declaration = this.program.getTypeChecker().getResolvedSignature(call)?.declaration;
        if (declaration === undefined) return false;
        const file = declaration.getSourceFile().fileName.replace(/\\/g, '/');
        return /(?:\/packages\/(?:http|cloud)\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-node|http-client-browser|cloudtasks-client)\//.test(file);
    }

    private recordWiring(declaration: ts.ClassDeclaration): void {
        const types = new WiringSourceTypes(this.program.getTypeChecker());
        const kind = types.kind(declaration);
        const owner = this.exportOwner(declaration);
        if (kind === undefined || owner === undefined) return;
        if (kind === 'binding' || kind === 'routing') {
            this.exported[owner] = new WiringExport(kind, [], []);
            const configure = types.method(declaration, 'configure');
            if (configure === undefined || configure.body === undefined)
                this.fail(`${owner}: named module requires a statically resolvable configure implementation.`);
            if (path.resolve(configure!.getSourceFile().fileName) !== this.wiringPath)
                this.fail(`${owner}: configure is inherited from ${configure!.getSourceFile().fileName}; declare its registrations in ${owner}.configure in ${this.wiringPath}.`);
            this.facts(configure!.body!, owner);
            return;
        }
        const bindings = this.moduleSelections(owner, types.method(declaration, 'getBindModules'), 'binding', kind);
        // The browser has no route channel; a Node Wiring's getRouteModules is required by its type.
        const routeGetter = types.method(declaration, 'getRouteModules');
        const routes = routeGetter === undefined ? [] : this.moduleSelections(owner, routeGetter, 'routing', kind);
        const libraries = kind === 'app' ? this.moduleSelections(owner, types.method(declaration, 'getWirings'), 'wiring', kind) : [];
        if (kind === 'wiring' && types.method(declaration, 'getWirings') !== undefined)
            this.fail(`${owner}: library Wiring cannot select other Wirings.`);
        this.exported[owner] = new WiringExport(kind, [], bindings, routes, libraries);
        if (kind !== 'app') return;
        if (!this.info.tags.includes('webpieces'))
            this.fail(`${owner}: library owners cannot declare an AppWiring entry.`);
        if (this.entry !== undefined) this.fail('Ambiguous AppWiring root; export exactly one application entry.');
        this.entry = owner;
        const projectFile = path.join(this.workspaceRoot, this.info.root, 'project.json');
        if (fs.existsSync(projectFile)) {
            const project = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as WiringProjectMetadata;
            this.host = project.metadata?.webpieces?.serviceName;
        }
    }

    private moduleSelections(owner: string, method: ts.MethodDeclaration | undefined, expected: 'binding' | 'routing' | 'wiring', ownerKind: WiringKind): WiringSelection[] {
        if (method !== undefined && path.resolve(method.getSourceFile().fileName) !== this.wiringPath)
            this.fail(`${owner}: its selection getter is declared in ${method.getSourceFile().fileName}; declare getBindModules/getRouteModules/getWirings on ${owner} itself in ${this.wiringPath}.`);
        const statements = method?.body?.statements;
        const expression = statements?.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression : undefined;
        if (expression === undefined || !ts.isArrayLiteralExpression(expression))
            this.fail(`Expected ${expected} getter to contain only return [new NamedModule(preparedInputs)].`);
        const types = new WiringSourceTypes(this.program.getTypeChecker());
        return expression.elements.map((element: ts.Expression) => {
            if (!ts.isNewExpression(element) || types.kind(element.expression) !== expected)
                this.fail(`Wrong ${expected} selection ${element.getText()}; AppWiring children, delegation and nested lists are forbidden.`);
            const identity = this.values.identity(element.expression);
            this.assertCanonicalDeclaration(owner, element.expression, identity, expected, ownerKind);
            return new WiringSelection(identity.project, identity.exportedName, this.values.arguments(element), this.values.policies(element));
        });
    }

    /**
     * OWNER-canonical: a selected module is declared in THIS wiring.ts, or - for a BindModule an
     * AppWiring selects, and for a library Wiring - in its library owner's canonical src/wiring.ts.
     * Proven by the resolved declaration (so a re-export resolves to its true file), never by a name,
     * and checked before any argument analysis, so an off-file module body is never read.
     */
    private assertCanonicalDeclaration(
        owner: string,
        selected: ts.Expression,
        identity: ContractIdentity,
        expected: 'binding' | 'routing' | 'wiring',
        ownerKind: WiringKind,
    ): void {
        const declaration = new WiringSourceTypes(this.program.getTypeChecker()).declaration(selected);
        const declaredIn = declaration === undefined ? 'an unresolved file' : path.resolve(declaration.getSourceFile().fileName);
        if (declaredIn === this.wiringPath && expected !== 'wiring') return;
        const library = this.infos.get(identity.project);
        const canonical = library === undefined ? undefined : path.resolve(this.workspaceRoot, library.root, 'src/wiring.ts');
        const fromLibrary = identity.project !== this.info.name && canonical !== undefined && declaredIn === canonical;
        if (expected === 'wiring' && fromLibrary) return;
        if (expected === 'binding' && ownerKind === 'app' && fromLibrary) return;
        if (expected === 'wiring')
            this.fail(
                `${owner} selects library Wiring ${identity.project}#${identity.exportedName}, which is declared in ${declaredIn}. A library Wiring and its modules belong in that library's canonical ${canonical ?? 'src/wiring.ts'}.`,
            );
        const role = expected === 'binding' ? 'BindModule' : 'RouteModule';
        const where = expected === 'binding' && ownerKind === 'app'
            ? ` beside ${owner} in ${this.wiringPath}, or in its library owner's canonical src/wiring.ts`
            : ` beside ${owner} in ${this.wiringPath}`;
        this.fail(
            `${owner} selects ${identity.exportedName}, which is declared in ${declaredIn}. Declare the ${role} class ${identity.exportedName}, with its registrations,${where}; a ContainerModule or a class in any other file is never a module.`,
        );
    }

    private exportOwner(node: ts.Node): string | undefined {
        let current: ts.Node | undefined = node;
        while (current !== undefined) {
            if (
                ts.isClassDeclaration(current) &&
                current.name !== undefined &&
                (ts.getModifiers(current) ?? []).some(
                    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                )
            )
                return current.name.text;
            if (
                ts.isFunctionDeclaration(current) &&
                current.name !== undefined &&
                (ts.getModifiers(current) ?? []).some(
                    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                )
            )
                return current.name.text;
            if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
                const statement = current.parent.parent;
                if (
                    ts.isVariableStatement(statement) &&
                    (ts.getModifiers(statement) ?? []).some(
                        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                    )
                )
                    return current.name.text;
            }
            current = current.parent;
        }
        return undefined;
    }

    private get wiringPath(): string {
        return path.resolve(this.workspaceRoot, this.info.root, 'src/wiring.ts');
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Declare each owner\'s Wiring/AppWiring class AND its BindModule/RouteModule classes, with their registrations (binder.createRpcClientAndBind(Api, deployment), binder.createPubSubClientAndBind, binder.bindExternal(Api, VendorImpl), binder.bind chains, browser binder.provide recipes, router.addRoutes/addFilter), together in that owner\'s canonical src/wiring.ts (an app may also select a BindModule from a library owner\'s canonical src/wiring.ts), and use the documented getter grammar (getBindModules/getRouteModules/getWirings); extraction reads only canonical wiring.ts files and never executes configuration.',
                true,
            ),
        ]);
    }
}

/** Factory kept separate so graph assembly cannot accidentally create a compiler. */
export class WiringProjectProgram {
    create(workspaceRoot: string, info: ProjectInfo): ts.Program {
        const root = path.resolve(workspaceRoot, info.root);
        const configured = createProjectProgram(root);
        if (configured !== null) return configured;
        const config = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
        const parsed =
            config === undefined ? undefined : ts.readConfigFile(config, ts.sys.readFile);
        const options =
            parsed === undefined
                ? {}
                : ts.parseJsonConfigFileContent(parsed.config, ts.sys, root).options;
        const files = ts.sys.readDirectory(
            path.join(root, 'src'),
            ['.ts'],
            ['**/*.spec.ts', '**/*.test.ts'],
        );
        return ts.createProgram(files, options);
    }
}
