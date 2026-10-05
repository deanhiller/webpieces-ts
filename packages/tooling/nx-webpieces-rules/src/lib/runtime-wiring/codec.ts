import { toError } from '../../toError';
import { Option, RuleFailError } from '@webpieces/rules-config';
import {
    ContractIdentity,
    ImplementsFacts,
    UsesFacts,
    RuntimeDeclaration,
    WiringExport,
    WiringRelationship,
    WiringSelection,
} from './declaration';
import type { DeclaredTarget, PolicyValue } from './declaration';
import { isExternalSystemKind } from '../api-usage/api-relations';

/** JSON is validated before it is allowed to influence graph assembly. */
export class RuntimeDeclarationCodec {
    decode(text: string, expectedProject: string): RuntimeDeclaration {
        const root = this.record(this.parse(text, expectedProject), [
            'schemaVersion',
            'project',
            'framework',
            'exports',
            'entry',
            'host',
        ]);
        if (root['schemaVersion'] !== 2)
            this.fail('Unsupported runtime-deps schemaVersion; migrate src/wiring.ts to Wiring/AppWiring and explicitly review a version 2 candidate.');
        if (root['project'] !== expectedProject)
            this.fail(`Expected project ${expectedProject}, found ${String(root['project'])}.`);
        const framework = this.string(root['framework']);
        if (framework !== 'node' && framework !== 'angular' && framework !== 'browser')
            this.fail(`Unsupported framework ${framework}.`);
        const exports: Record<string, WiringExport> = {};
        for (const [name, value] of Object.entries(this.record(root['exports'])))
            exports[name] = this.exported(value);
        const entry = root['entry'] === undefined ? undefined : this.string(root['entry']);
        const apps = Object.values(exports).filter((exported: WiringExport) => exported.kind === 'app');
        if ((entry === undefined && apps.length > 0) || (entry !== undefined && apps.length !== 1))
            this.fail('Declare exactly one AppWiring entry for an application; libraries export Wiring without an entry.');
        if (entry !== undefined && exports[entry]?.kind !== 'app')
            this.fail('A runtime entry must select an AppWiring export. Libraries have no entry.');
        if (entry === undefined && root['host'] !== undefined)
            this.fail('Library declarations cannot carry an application host.');
        for (const [name, exported] of Object.entries(exports)) {
            if (exported.kind !== 'app' && exported.wirings.length > 0)
                this.fail(`${name}: only AppWiring may select library Wirings.`);
            if (!['app', 'wiring'].includes(exported.kind) &&
                (exported.bindModules.length > 0 || exported.routeModules.length > 0))
                this.fail(`${name}: leaf modules cannot select module lists.`);
            if (['app', 'wiring'].includes(exported.kind) && exported.relationships.length > 0)
                this.fail(`${name}: declare relationships in named binding/route modules.`);
        }
        return new RuntimeDeclaration(
            expectedProject,
            framework,
            exports,
            root['entry'] === undefined ? undefined : this.string(root['entry']),
            root['host'] === undefined ? undefined : this.string(root['host']),
        );
    }

    // webpieces-disable no-any-unknown -- JSON syntax boundary; fields are narrowed by decode
    private parse(text: string, project: string): unknown {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return JSON.parse(text);
        } catch (err: unknown) {
            const error = toError(err);
            this.fail(`${project}/runtime-deps.json contains invalid JSON.`, error);
        }
    }

    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed and validated at the input boundary
    private exported(value: unknown): WiringExport {
        this.renamed(value, 'bindingModules', 'bindModules');
        this.renamed(value, 'routingModules', 'routeModules');
        const exported = this.record(value, ['kind', 'relationships', 'bindModules', 'routeModules', 'wirings']);
        const kind = this.string(exported['kind']);
        if (
            kind !== 'binding' &&
            kind !== 'routing' &&
            kind !== 'wiring' &&
            kind !== 'app' &&
            kind !== 'external'
        )
            this.fail(`Invalid export kind ${kind}.`);
        return new WiringExport(
            kind,
            this.array(exported['relationships']).map((value) => this.relationship(value)),
            this.array(exported['bindModules']).map((value) => this.selection(value)),
            this.array(exported['routeModules']).map((value) => this.selection(value)),
            this.array(exported['wirings']).map((value) => this.selection(value)),
        );
    }

    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed before the renamed-field check
    private renamed(value: unknown, old: string, renamed: string): void {
        if (Object.hasOwn(this.record(value), old))
            this.fail(`runtime-deps field ${old} was renamed to ${renamed}; regenerate the candidate from src/wiring.ts (getBindModules/getRouteModules) and review it.`);
    }

    // webpieces-disable no-any-unknown -- untrusted relationship JSON is narrowed before construction
    private relationship(value: unknown): WiringRelationship {
        const relation = this.record(value, [
            'contract',
            'direction',
            'transport',
            'target',
            'policy',
        ]);
        const contract = this.record(relation['contract'], ['project', 'exportedName']);
        const direction = this.string(relation['direction']);
        const transport = this.string(relation['transport']);
        if (direction !== 'implements' && direction !== 'uses')
            this.fail(`Invalid direction ${direction}.`);
        if (transport !== 'rpc' && transport !== 'pubsub' && transport !== 'external')
            this.fail(`Invalid transport ${transport}.`);
        const target =
            relation['target'] === undefined ? undefined : this.target(relation['target']);
        const policy =
            relation['policy'] === undefined ? undefined : this.string(relation['policy']);
        if (direction === 'uses' && target === undefined)
            this.fail('Uses requires an explicit target.');
        if (direction === 'implements' && target !== undefined)
            this.fail('Implements cannot declare a client target.');
        return new WiringRelationship(
            new ContractIdentity(
                this.string(contract['project']),
                this.string(contract['exportedName']),
            ),
            direction === 'uses'
                ? new UsesFacts(transport, target!, policy)
                : new ImplementsFacts(transport, policy),
        );
    }

    // webpieces-disable no-any-unknown -- untrusted selection arguments are validated before substitution
    private selection(value: unknown): WiringSelection {
        const selection = this.record(value, ['project', 'exportedName', 'targets', 'policies']);
        const targets: Record<string, DeclaredTarget> = {};
        const policies: Record<string, PolicyValue> = {};
        for (const [name, target] of Object.entries(this.record(selection['targets'])))
            targets[name] = this.target(target);
        for (const [name, policy] of Object.entries(this.record(selection['policies']))) {
            if (typeof policy === 'boolean' || policy === 'runtime') policies[name] = policy;
            else {
                const forwarded = this.record(policy, ['parameter']);
                policies[name] = { parameter: this.string(forwarded['parameter']) };
            }
        }
        return new WiringSelection(
            this.string(selection['project']),
            this.string(selection['exportedName']),
            targets,
            policies,
        );
    }

    // webpieces-disable no-any-unknown -- target discriminant controls the exact accepted JSON shape
    private target(value: unknown): DeclaredTarget {
        const target = this.record(value);
        switch (target['kind']) {
            case 'service': {
                this.record(value, ['kind', 'service', 'contract']);
                const contract =
                    target['contract'] === undefined
                        ? undefined
                        : this.record(target['contract'], ['project', 'exportedName']);
                return {
                    kind: 'service',
                    service: this.string(target['service']),
                    contract:
                        contract === undefined
                            ? undefined
                            : new ContractIdentity(
                                  this.string(contract['project']),
                                  this.string(contract['exportedName']),
                              ),
                };
            }
            case 'parameter':
                this.record(value, ['kind', 'parameter']);
                return { kind: 'parameter', parameter: this.string(target['parameter']) };
            case 'unknown':
                this.record(value, ['kind', 'reason']);
                return { kind: 'unknown', reason: this.string(target['reason']) };
            case 'external': {
                this.record(value, ['kind', 'system']);
                const system = this.record(target['system'], ['kind', 'label']);
                const kind = this.string(system['kind']);
                if (!isExternalSystemKind(kind)) this.fail(`Invalid external system kind ${kind}.`);
                return { kind: 'external', system: { kind, label: this.string(system['label']) } };
            }
            default:
                return this.fail(
                    'Targets require an explicit service, parameter, external, or unknown kind.',
                );
        }
    }

    // webpieces-disable no-any-unknown -- JSON record boundary; never a runtime topology type
    private record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            this.fail('Expected a JSON object.');
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record))
            if (['__proto__', 'constructor', 'prototype'].includes(key))
                this.fail(`Reserved runtime-deps field ${key}.`);
        if (allowed !== undefined)
            for (const key of Object.keys(record))
                if (!allowed.includes(key)) this.fail(`Unknown runtime-deps field ${key}.`);
        return record;
    }

    // webpieces-disable no-any-unknown -- JSON array boundary
    private array(value: unknown): unknown[] {
        if (!Array.isArray(value)) this.fail('Expected a JSON array.');
        return value;
    }

    // webpieces-disable no-any-unknown -- JSON scalar boundary
    private string(value: unknown): string {
        if (typeof value !== 'string' || value.trim() === '')
            this.fail('Expected a non-empty string.');
        return value;
    }

    private fail(message: string, cause?: Error): never {
        throw new RuleFailError(
            'validate-runtime-architecture',
            message,
            undefined,
            undefined,
            [
                new Option(
                    'Review and correct runtime-deps.json using the versioned runtime wiring schema.',
                    true,
                ),
            ],
            undefined,
            cause,
        );
    }
}
