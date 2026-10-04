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
import { CanonicalClientBindings } from './canonical-clients';

/** Build-only extraction. It never imports application modules or invokes their constructors. */
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

    extract(): RuntimeDeclaration {
        const clients = new CanonicalClientBindings(this.program.getTypeChecker());
        const problems = this.program
            .getSourceFiles()
            .filter(
                (file) =>
                    !file.isDeclarationFile &&
                    this.owns(file.fileName) &&
                    !/(?:\.spec\.|\.test\.|\/__tests__\/)/.test(file.fileName),
            )
            .flatMap((file) => clients.problems(file));
        clients.assert(problems);
        const wiringPath = path.resolve(this.workspaceRoot, this.info.root, 'src/wiring.ts');
        const wiring = this.program.getSourceFile(wiringPath);
        if (wiring === undefined) this.fail(`Missing canonical ${wiringPath}.`);
        for (const file of this.program.getSourceFiles()) {
            if (
                file.isDeclarationFile ||
                !this.owns(file.fileName) ||
                /(?:\.spec\.|\.test\.|\/__tests__\/)/.test(file.fileName)
            )
                continue;
            this.visit(file, file.fileName === wiringPath);
        }
        const framework = this.info.tags.includes('framework:angular')
            ? 'angular'
            : this.info.tags.some((tag) => tag === 'framework:node' || tag === 'framework:express')
              ? 'node'
              : 'browser';
        if (this.info.tags.includes('webpieces') && this.entry === undefined)
            this.fail(`${this.info.name} requires getRuntimeWiring() returning a typed plan.`);
        return new RuntimeDeclaration(
            this.info.name,
            framework,
            this.exported,
            this.entry,
            this.host,
        );
    }

    private visit(node: ts.Node, inWiring: boolean): void {
        if (
            !inWiring &&
            (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
            [
                'addRoutes',
                'createRpcClient',
                'createPubSubClient',
                'bindRpc',
                'bindPubSub',
            ].includes(this.values.symbolName(node))
        )
            this.fail(
                `${node.getSourceFile().fileName}: topology method references belong in src/wiring.ts, including aliases.`,
            );
        if (
            inWiring &&
            ts.isNewExpression(node) &&
            this.values.symbolName(node.expression) === 'ExternalContractUse'
        )
            this.recordExternal(node);
        if (ts.isCallExpression(node)) {
            const name = this.values.symbolName(node.expression);
            if (
                [
                    'addRoutes',
                    'createRpcClient',
                    'createPubSubClient',
                    'bindRpc',
                    'bindPubSub',
                    'provideRpcClient',
                ].includes(name)
            ) {
                if (!inWiring)
                    this.fail(
                        `${node.getSourceFile().fileName}: ${name} must be owned by src/wiring.ts.`,
                    );
                this.recordRelationship(node, name);
            }
        }
        if (inWiring && ts.isMethodDeclaration(node) && node.name.getText() === 'getRuntimeWiring')
            this.recordPlan(node);
        ts.forEachChild(node, (child) => this.visit(child, inWiring));
    }

    private recordExternal(expression: ts.NewExpression): void {
        const owner = this.exportOwner(expression);
        const identity = expression.arguments?.[0];
        if (owner === undefined || identity === undefined || !ts.isStringLiteralLike(identity))
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
        const exported = this.exported[owner!] ?? new WiringExport('binding', [], []);
        exported.relationships.push(
            new WiringRelationship(
                new ContractIdentity(project, exportedName),
                new UsesFacts('external', {
                    kind: 'unknown',
                    reason: 'Vendor interface; destination classified by approved contract metadata',
                }),
            ),
        );
        this.exported[owner!] = exported;
    }

    private recordRelationship(call: ts.CallExpression, method: string): void {
        const owner = this.exportOwner(call);
        // The generic Angular integration adapter defines the primitive; its invocations own facts.
        if (owner === 'provideRpcClient' && method === 'createRpcClient') return;
        if (owner === undefined)
            this.fail(`Unowned ${method} at ${call.getSourceFile().fileName}:${call.getStart()}.`);
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
        const kind =
            direction === 'implements'
                ? 'routing'
                : method === 'provideRpcClient'
                  ? 'providers'
                  : 'binding';
        const exported = this.exported[owner!] ?? new WiringExport(kind, [], []);
        exported.relationships.push(
            new WiringRelationship(
                contract,
                direction === 'implements'
                    ? new ImplementsFacts(transport, this.values.condition(call))
                    : new UsesFacts(transport, target!, this.values.condition(call)),
            ),
        );
        this.exported[owner!] = exported;
    }

    private recordPlan(method: ts.MethodDeclaration): void {
        const owner = this.exportOwner(method);
        if (owner === undefined) this.fail('The plan class must be exported from src/wiring.ts.');
        const returns = this.planReturns(method, owner!);
        const expression = returns[0].expression as ts.NewExpression;
        const name = this.values.symbolName(expression.expression);
        const args = expression.arguments ?? [];
        let arrays: readonly ts.Expression[];
        if (name === 'ServerWiring') {
            const host = this.values.target(args[0]);
            if (host.kind !== 'service')
                this.fail('ServerWiring requires a literal host identity.');
            this.host = host.service;
            if (
                args[1] === undefined ||
                !ts.isNewExpression(args[1]) ||
                this.values.symbolName(args[1].expression) !== 'ServerWiringOptions'
            )
                this.fail(
                    'Use ServerWiringOptions with separate bindingModules and routingModules arrays.',
                );
            arrays = (args[1] as ts.NewExpression).arguments ?? [];
        } else if (name === 'BrowserWiring') arrays = args;
        else this.fail(`Unsupported plan ${name}; use ServerWiring or BrowserWiring.`);
        const selections: WiringSelection[] = [];
        for (const array of arrays) {
            if (!ts.isArrayLiteralExpression(array))
                this.fail(
                    'Plan module/provider lists must be static arrays; dynamic composition needs an explicit supported policy.',
                );
            for (const element of (array as ts.ArrayLiteralExpression).elements) {
                if (ts.isObjectLiteralExpression(element)) continue; // ordinary Angular providers; API factories are checked independently
                if (
                    ts.isCallExpression(element) &&
                    this.values.symbolName(element.expression) === 'provideRpcClient'
                )
                    continue;
                const invocation =
                    ts.isNewExpression(element) || ts.isCallExpression(element)
                        ? element
                        : undefined;
                const identity = this.values.identity(
                    invocation === undefined ? element : invocation.expression,
                );
                const targets = invocation === undefined ? {} : this.values.arguments(invocation);
                selections.push(
                    new WiringSelection(
                        identity.project,
                        identity.exportedName,
                        targets,
                        invocation === undefined ? {} : this.values.policies(invocation),
                    ),
                );
                if (
                    identity.project === this.info.name &&
                    this.exported[identity.exportedName] === undefined
                )
                    this.exported[identity.exportedName] = new WiringExport('binding', [], []);
            }
        }
        this.exported[owner!] = new WiringExport('plan', [], selections);
        this.entry = owner;
    }

    private planReturns(method: ts.MethodDeclaration, owner: string): ts.ReturnStatement[] {
        const returns: ts.ReturnStatement[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isReturnStatement(node)) returns.push(node);
            else ts.forEachChild(node, visit);
        };
        if (method.body !== undefined) visit(method.body);
        if (
            returns.length !== 1 ||
            returns[0].expression === undefined ||
            !ts.isNewExpression(returns[0].expression)
        )
            this.fail(`${owner}.getRuntimeWiring must return one statically composed plan.`);
        return returns;
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

    private owns(file: string): boolean {
        const root = path.resolve(this.workspaceRoot, this.info.root) + path.sep;
        return path.resolve(file).startsWith(root) && !file.includes('/node_modules/');
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Move topology into canonical src/wiring.ts using RuntimeClients.bindRpc(token, Api, rpcTarget(Api, deployment)), RuntimeTaskClients.bindPubSub, or provideRpcClient for supported registrations, and use the documented static plan grammar; do not execute configuration to extract it.',
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
