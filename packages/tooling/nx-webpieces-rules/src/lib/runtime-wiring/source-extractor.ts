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

    private facts(node: ts.Node, owner: string): void {
        if (ts.isNewExpression(node) && new WiringSourceTypes(this.program.getTypeChecker()).isFramework(node.expression, 'ExternalContractUse'))
            this.recordExternal(node, owner);
        if (ts.isCallExpression(node) && this.frameworkCall(node)) {
            const name = this.values.symbolName(node.expression);
            if (['addRoutes', 'createRpcClient', 'createPubSubClient', 'bindRpc', 'bindPubSub', 'provideRpcClient'].includes(name))
                this.recordRelationship(node, name, owner);
        }
        ts.forEachChild(node, (child: ts.Node) => this.facts(child, owner));
    }

    private recordExternal(expression: ts.NewExpression, owner: string): void {
        const identity = expression.arguments?.[0];
        if (identity === undefined || !ts.isStringLiteralLike(identity))
            this.fail(
                'ExternalContractUse belongs to a selected exported module and requires a literal project#contract identity.',
            );
        const qualified = (identity as ts.StringLiteralLike).text.split('#');
        const project = qualified[0];
        const exportedName = qualified[1];
        const extra = qualified[2];
        if (!project || !exportedName || extra !== undefined)
            this.fail('ExternalContractUse requires one qualified project#contract identity.');
        if (!this.values.hasExternalConsumer(this.info.name, project, exportedName, this.program))
            this.fail(
                `${project}#${exportedName} has no production business consumer in ${this.info.name}; adapters and test doubles do not establish uses.`,
            );
        const exported = this.exported[owner];
        exported.relationships.push(
            new WiringRelationship(
                new ContractIdentity(project, exportedName),
                new UsesFacts('external', {
                    kind: 'unknown',
                    reason: 'Vendor interface; destination classified by approved contract metadata',
                }),
            ),
        );
        this.exported[owner] = exported;
    }

    private recordRelationship(call: ts.CallExpression, method: string, owner: string): void {
        const apiIndex =
            method === 'bindRpc' || method === 'bindPubSub' || method === 'provideRpcClient'
                ? 1
                : 0;
        const api = call.arguments[apiIndex];
        if (api === undefined) this.fail(`${method} requires an explicit API contract.`);
        const contract = this.values.identity(api!);
        const direction = method === 'addRoutes' ? 'implements' : 'uses';
        const contractTransport = this.values.transport(api!);
        const transport =
            method === 'addRoutes'
                ? contractTransport
                : method === 'bindPubSub' || method === 'createPubSubClient'
                  ? 'pubsub'
                  : 'rpc';
        if (transport !== contractTransport)
            this.fail(
                `${method} transport disagrees with ${contract.project}#${contract.exportedName}.`,
            );
        const target =
            direction === 'implements'
                ? undefined
                : this.values.target(call.arguments[apiIndex + 1]);
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
        const bindings = this.moduleSelections(owner, types.method(declaration, 'getBindingModules'), 'binding');
        const routes = this.moduleSelections(owner, types.method(declaration, 'getRoutingModules'), 'routing');
        const libraries = kind === 'app' ? this.moduleSelections(owner, types.method(declaration, 'getWirings'), 'wiring') : [];
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

    private moduleSelections(owner: string, method: ts.MethodDeclaration | undefined, expected: 'binding' | 'routing' | 'wiring'): WiringSelection[] {
        if (method !== undefined && path.resolve(method.getSourceFile().fileName) !== this.wiringPath)
            this.fail(`${owner}: its selection getter is declared in ${method.getSourceFile().fileName}; declare getBindingModules/getRoutingModules/getWirings on ${owner} itself in ${this.wiringPath}.`);
        const statements = method?.body?.statements;
        const expression = statements?.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression : undefined;
        if (expression === undefined || !ts.isArrayLiteralExpression(expression))
            this.fail(`Expected ${expected} getter to contain only return [new NamedModule(preparedInputs)].`);
        const types = new WiringSourceTypes(this.program.getTypeChecker());
        return expression.elements.map((element: ts.Expression) => {
            if (!ts.isNewExpression(element) || types.kind(element.expression) !== expected)
                this.fail(`Wrong ${expected} selection ${element.getText()}; AppWiring children, delegation and nested lists are forbidden.`);
            const identity = this.values.identity(element.expression);
            this.assertCanonicalDeclaration(owner, element.expression, identity, expected);
            return new WiringSelection(identity.project, identity.exportedName, this.values.arguments(element), this.values.policies(element));
        });
    }

    /**
     * A selected module must be declared in THIS wiring.ts, and a selected library Wiring in its own
     * owner's src/wiring.ts. Proven by the resolved declaration, never by a name, and checked before
     * any argument analysis, so an off-file module body is never read.
     */
    private assertCanonicalDeclaration(
        owner: string,
        selected: ts.Expression,
        identity: ContractIdentity,
        expected: 'binding' | 'routing' | 'wiring',
    ): void {
        const declaration = new WiringSourceTypes(this.program.getTypeChecker()).declaration(selected);
        const declaredIn = declaration === undefined ? 'an unresolved file' : path.resolve(declaration.getSourceFile().fileName);
        if (expected !== 'wiring') {
            if (declaredIn === this.wiringPath) return;
            const role = expected === 'binding' ? 'BindingModule' : 'RouteModule';
            this.fail(
                `${owner} selects ${identity.exportedName}, which is declared in ${declaredIn}. Declare the ${role} class ${identity.exportedName}, with its registrations, beside ${owner} in ${this.wiringPath}.`,
            );
        }
        const library = this.infos.get(identity.project);
        const canonical = library === undefined ? undefined : path.resolve(this.workspaceRoot, library.root, 'src/wiring.ts');
        if (canonical !== undefined && declaredIn === canonical) return;
        this.fail(
            `${owner} selects library Wiring ${identity.project}#${identity.exportedName}, which is declared in ${declaredIn}. A library Wiring and its modules belong in that library's canonical ${canonical ?? 'src/wiring.ts'}.`,
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
                'Declare each owner\'s Wiring/AppWiring class AND its BindingModule/RouteModule classes, with their registrations (RuntimeClients.bindRpc(token, Api, deployment), RuntimeTaskClients.bindPubSub, provideRpcClient, addRoutes, addFilter, DI binds), together in that owner\'s canonical src/wiring.ts, and use the documented getter grammar; extraction reads only wiring.ts and never executes configuration.',
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
