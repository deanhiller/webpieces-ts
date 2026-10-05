import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ApiTransport } from '../api-usage/api-relations';
import type {
    DeclaredTarget,
    RuntimeDeclaration,
    WiringExport,
    WiringRelationship,
    PolicyValue,
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
        const root = newSelection(project, declaration.entry!);
        const app = this.exported(root, 'app');
        const selections = [root, ...app.wirings.map((child: WiringSelection) => this.forward(child, root))];
        const result: ResolvedWiringRelationship[] = [];
        for (const channel of ['bindModules', 'routeModules'] as const) {
            for (const [index, selection] of selections.entries()) {
                const owner = this.exported(selection, index === 0 ? 'app' : 'wiring');
                if (index > 0 && owner.wirings.length > 0)
                    this.fail(`Only AppWiring selects libraries: ${selection.project}#${selection.exportedName}.`);
                for (const [moduleIndex, module] of owner[channel].entries()) {
                    const selected = this.forward(module, selection);
                    const leaf = this.exported(selected, channel === 'bindModules' ? 'binding' : 'routing');
                    if (leaf.bindModules.length + leaf.routeModules.length + leaf.wirings.length > 0)
                        this.fail('Leaf modules cannot hide composition or composition cycles.');
                    const via = `${project}#${declaration.entry}/${index}:${selection.project}#${selection.exportedName}/${channel}[${moduleIndex}]:${selected.project}#${selected.exportedName}`;
                    result.push(...this.resolveRelationships(leaf, selected, via));
                }
            }
        }
        return result;
    }

    private exported(selection: WiringSelection, kind: WiringExport['kind']): WiringExport {
        const key = `${selection.project}#${selection.exportedName}`;
        const declaration = this.getDeclaration(selection.project);
        const exported = Object.hasOwn(declaration.exports, selection.exportedName)
            ? declaration.exports[selection.exportedName]
            : undefined;
        if (exported === undefined) this.fail(`Missing approved export ${key}.`);
        if (exported.kind !== kind)
            this.fail(`${key}: expected ${kind}, found ${exported.kind}. Nested app/library composition is unsupported.`);
        return exported;
    }

    private forward(child: WiringSelection, parent: WiringSelection): WiringSelection {
        const targets: Record<string, DeclaredTarget> = {};
        const policies: Record<string, PolicyValue> = {};
        for (const [name, target] of Object.entries(child.targets))
            targets[name] = this.resolveTarget(target, parent);
        for (const [name, value] of Object.entries(child.policies)) {
            const resolved = typeof value === 'object' ? parent.policies[value.parameter] : value;
            if (resolved === undefined || typeof resolved === 'object')
                this.fail(`Unresolved policy parameter ${name} via ${parent.project}#${parent.exportedName}.`);
            policies[name] = resolved;
        }
        return new WiringSelection(child.project, child.exportedName, targets, policies);
    }

    private resolveRelationships(
        exported: WiringExport,
        selection: WiringSelection,
        via: string,
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
                    via,
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
    policies: Record<string, PolicyValue> = {},
): WiringSelection {
    return new WiringSelection(project, exportedName, targets, policies);
}
