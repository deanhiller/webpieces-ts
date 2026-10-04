import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ApiTransport } from '../api-usage/api-relations';
import type {
    DeclaredTarget,
    RuntimeDeclaration,
    WiringExport,
    WiringRelationship,
} from './declaration';
import { WiringSelection } from './declaration';

export class ResolvedWiringRelationship {
    constructor(
        public readonly owner: string,
        public readonly api: string,
        public readonly direction: 'implements' | 'uses',
        public readonly transport: ApiTransport,
        public readonly via: string,
        public readonly target?: DeclaredTarget,
        public readonly conditional?: string,
    ) {}
}

/** Pure assembly of reviewed declarations; importing a library never activates its exports. */
export class RuntimeWiringAssembler {
    constructor(private readonly declarations: ReadonlyMap<string, RuntimeDeclaration>) {}

    assemble(project: string): ResolvedWiringRelationship[] {
        const declaration = this.getDeclaration(project);
        if (declaration.entry === undefined) this.fail(`${project} has no approved app entry.`);
        return this.visit(newSelection(project, declaration.entry!), new Set<string>());
    }

    private visit(selection: WiringSelection, stack: Set<string>): ResolvedWiringRelationship[] {
        const key = `${selection.project}#${selection.exportedName}`;
        if (stack.has(key)) this.fail(`Runtime composition cycle: ${[...stack, key].join(' -> ')}`);
        const declaration = this.getDeclaration(selection.project);
        const exported = Object.hasOwn(declaration.exports, selection.exportedName)
            ? declaration.exports[selection.exportedName]
            : undefined;
        if (exported === undefined) this.fail(`Missing approved export ${key}.`);
        const active = new Set([...stack, key]);
        const relationships = this.resolveRelationships(exported!, selection);
        for (const child of exported!.selections) {
            const targets: Record<string, DeclaredTarget> = {};
            for (const name of Object.keys(child.targets))
                targets[name] = this.resolveTarget(child.targets[name], selection);
            const next = newSelection(child.project, child.exportedName, targets, {
                ...selection.policies,
                ...child.policies,
            });
            relationships.push(...this.visit(next, active));
        }
        return relationships;
    }

    private resolveRelationships(
        exported: WiringExport,
        selection: WiringSelection,
    ): ResolvedWiringRelationship[] {
        const result: ResolvedWiringRelationship[] = [];
        for (const relationship of exported.relationships) {
            if (!this.isEnabled(relationship, selection)) continue;
            const target =
                relationship.target === undefined
                    ? undefined
                    : this.resolveTarget(relationship.target, selection);
            if (
                target?.kind === 'service' &&
                target.contract !== undefined &&
                (target.contract.project !== relationship.contract.project ||
                    target.contract.exportedName !== relationship.contract.exportedName)
            )
                this.fail(
                    `Target capability ${target.contract.project}#${target.contract.exportedName} disagrees with ${relationship.contract.project}#${relationship.contract.exportedName}.`,
                );
            if (relationship.direction === 'uses' && target === undefined)
                this.fail(`Missing target for ${relationship.contract.exportedName}.`);
            result.push(
                new ResolvedWiringRelationship(
                    relationship.contract.project,
                    relationship.contract.exportedName,
                    relationship.direction,
                    relationship.transport,
                    `${selection.project}#${selection.exportedName}`,
                    target,
                    relationship.policy !== undefined &&
                    selection.policies[relationship.policy] === 'runtime'
                        ? `${selection.project}#${selection.exportedName}:${relationship.policy}`
                        : undefined,
                ),
            );
        }
        return result;
    }

    private isEnabled(relationship: WiringRelationship, selection: WiringSelection): boolean {
        if (relationship.policy === undefined) return true;
        const decision = selection.policies[relationship.policy];
        if (decision === undefined)
            this.fail(
                `Missing explicit policy ${relationship.policy} in ${selection.project}#${selection.exportedName}.`,
            );
        return decision === 'runtime' || decision === true;
    }

    private resolveTarget(target: DeclaredTarget, selection: WiringSelection): DeclaredTarget {
        if (target.kind !== 'parameter') return target;
        const argument = selection.targets[target.parameter];
        if (argument === undefined || argument.kind === 'parameter')
            this.fail(
                `Unresolved target parameter ${target.parameter} in ${selection.project}#${selection.exportedName}.`,
            );
        return argument!;
    }

    private getDeclaration(project: string): RuntimeDeclaration {
        const declaration = this.declarations.get(project);
        if (declaration === undefined)
            this.fail(`Missing approved runtime-deps.json for ${project}.`);
        return declaration!;
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Migrate src/wiring.ts and review its runtime-deps.json before generating the graph.',
                true,
            ),
        ]);
    }
}

// webpieces-disable no-function-outside-class -- construction helper for the pure assembly entry point
function newSelection(
    project: string,
    exportedName: string,
    targets: Record<string, DeclaredTarget> = {},
    policies: Record<string, boolean | 'runtime'> = {},
): WiringSelection {
    return new WiringSelection(project, exportedName, targets, policies);
}
