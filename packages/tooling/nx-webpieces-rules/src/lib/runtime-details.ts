import type { GraphRenderModel } from './graph-render-model';
import type { RuntimeGraph } from './runtime-graph-model';

export class RuntimeNodeDetails {
    constructor(
        public readonly implemented: string[],
        public readonly used: string[],
    ) {}
}

/** View data stays complete even when external destinations are hidden from DOT. */
export class RuntimeDetails {
    readonly nodes: Record<string, RuntimeNodeDetails> = {};
    readonly edges: Record<string, string[]> = {};

    constructor(
        graph: RuntimeGraph,
        showExternalNodes: boolean,
        model: GraphRenderModel | null = null,
    ) {
        for (const [name, service] of Object.entries(graph.services)) {
            const implemented = service.implements.map(
                (api) =>
                    `${graph.apis[api]?.owner ?? '?'}#${api}` +
                    (service.implementsVia?.[api] === undefined
                        ? ''
                        : ` via ${service.implementsVia[api]}`),
            );
            const used: string[] = [];
            for (const edge of graph.runtimeEdges.filter((edge) => edge.from === name)) {
                const entries = edge.via.map(
                    (api) =>
                        `${graph.apis[api]?.owner ?? '?'}#${api} → ${edge.to} (${edge.type ?? 'rpc'})` +
                        (edge.queue === undefined ? '' : ` via ${edge.queue}`),
                );
                if (service.wiringUses === undefined) used.push(...entries);
                if (edge.type !== 'pubsub') this.edges[`${edge.from}->${edge.to}`] = entries;
            }
            for (const api of service.wiringUses === undefined ? service.uses : []) {
                if (graph.runtimeEdges.some((edge) => edge.from === name && edge.via.includes(api)))
                    continue;
                const contract = graph.apis[api];
                const external =
                    contract?.type === 'external' || contract?.implementedBy.length === 0;
                used.push(
                    `${contract?.owner ?? '?'}#${api} → ${external ? (contract?.externalSystem?.label ?? contract?.owner ?? 'unknown external') : 'unknown / inferred target'}` +
                        ` (${contract?.type ?? 'rpc'})${external && !showExternalNodes ? ' — destination hidden' : ''}`,
                );
            }
            for (const ref of service.wiringImplements ?? []) {
                implemented.push(
                    `${graph.apis[ref.api]?.owner ?? '?'}#${ref.api} via ${ref.declaredVia ?? name}` +
                        (ref.conditional === undefined ? '' : ` conditional on ${ref.conditional}`),
                );
            }
            for (const ref of service.wiringUses ?? []) {
                used.push(
                    `${graph.apis[ref.api]?.owner ?? '?'}#${ref.api} → ${ref.targetService ?? 'unknown external target'} via ${ref.declaredVia ?? name}` +
                        (ref.conditional === undefined
                            ? ''
                            : ` conditional on ${ref.conditional}`) +
                        (ref.methodsInferred ? ' — queue methods inferred from contract' : ''),
                );
            }
            for (const [identity, system] of Object.entries(graph.externalSystems ?? {})) {
                if (!system.usedBy.includes(name)) continue;
                this.edges[`${name}->system__${identity.replace(/[^a-zA-Z0-9_]/g, '_')}`] =
                    system.apis.map(
                        (api) =>
                            `${graph.apis[api]?.owner ?? '?'}#${api} → ${system.label} (${system.kind})`,
                    );
            }
            for (const use of graph.unresolvedUses.filter((use) => use.service === name)) {
                if (graph.apis[use.api]?.externalSystem !== undefined) continue;
                const owner = graph.apis[use.api]?.owner ?? use.api;
                const key = `${name}->external__${owner}`;
                (this.edges[key] ??= []).push(`${owner}#${use.api} → ${owner} (external)`);
            }
            this.nodes[name] = new RuntimeNodeDetails(implemented, [...new Set(used)]);
        }
        if (model !== null) this.renderEdges(graph, model);
    }

    /** Bind detail facts to renderer-owned identities, including grouped queue hops. */
    private renderEdges(graph: RuntimeGraph, model: GraphRenderModel): void {
        for (const edge of model.edges) {
            const identity = `${edge.from}->${edge.to}`;
            const service = graph.services[edge.from] === undefined ? edge.to : edge.from;
            const queue = model.nodes.find(
                (node) => node.id === (edge.from.startsWith('queue__') ? edge.from : edge.to),
            );
            const via = graph.runtimeEdges.filter((call) => {
                if (call.type !== 'pubsub') return call.from === edge.from && call.to === edge.to;
                if (call.from !== service && call.to !== service) return false;
                return (
                    queue !== undefined &&
                    queue.queueKeys.includes(call.queue ?? `${call.from}->${call.to}`)
                );
            });
            const entries = [...(this.edges[identity] ?? [])];
            for (const call of via) {
                for (const api of call.via) {
                    entries.push(
                        `${graph.apis[api]?.owner ?? '?'}#${api} → ${call.to} (${call.type ?? 'rpc'})` +
                            (call.queue === undefined ? '' : ` via ${call.queue}`),
                    );
                    for (const ref of graph.services[call.from]?.wiringUses ?? []) {
                        if (
                            ref.api !== api ||
                            (ref.targetService !== undefined && ref.targetService !== call.to)
                        )
                            continue;
                        entries.push(
                            `${ref.api} via ${ref.declaredVia ?? call.from}` +
                                (ref.conditional === undefined
                                    ? ''
                                    : ` conditional on ${ref.conditional}`) +
                                (ref.methodsInferred
                                    ? ' — queue methods inferred from contract'
                                    : ''),
                        );
                    }
                }
            }
            for (const ref of graph.services[service]?.wiringUses ?? []) {
                if (!entries.some((entry) => entry.includes(`#${ref.api} →`))) continue;
                entries.push(
                    `${ref.api} via ${ref.declaredVia ?? service}` +
                        (ref.conditional === undefined
                            ? ''
                            : ` conditional on ${ref.conditional}`) +
                        (ref.methodsInferred ? ' — queue methods inferred from contract' : ''),
                );
            }
            this.edges[identity] = [...new Set(entries)];
        }
    }

    script(): string {
        const encoded = JSON.stringify(this).replace(/</g, '\\u003c');
        return `new (${RuntimeDetailsController.toString()})(${encoded});`;
    }
}

/** Explicit click controller; redraws rebind edge controls and dismiss stale anchors. */
class RuntimeDetailsController {
    private readonly host = document.getElementById('graph');
    private readonly panel = document.createElement('div');
    private anchor: SVGElement | null = null;
    private identity = '';
    private implemented = false;

    constructor(private readonly data: RuntimeDetails) {
        if (this.host === null) return;
        this.panel.className = 'wp-graph-details';
        this.panel.hidden = true;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'API relationships');
        document.body.append(this.panel);
        new MutationObserver(() => this.attach()).observe(this.host, { childList: true });
        this.attach();
        document.addEventListener('wp-runtime-implements', (event) => {
            const detail = (event as CustomEvent<RuntimeImplementsPayload>).detail;
            this.open(
                detail.node,
                this.data.nodes[detail.name]?.implemented ?? [],
                detail.name,
                true,
            );
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) {
                event.stopPropagation();
                this.close();
            }
        });
        document.addEventListener('click', (event) => {
            if (
                event.target instanceof Node &&
                !this.panel.contains(event.target) &&
                !this.anchor?.contains(event.target)
            )
                this.close();
        });
        document.addEventListener('wp-graph-transform', () => this.position());
        this.host.addEventListener('scroll', () => this.position());
        window.addEventListener('resize', () => this.position());
    }

    private position(): void {
        if (this.anchor === null || this.panel.hidden) return;
        const rect = this.anchor.getBoundingClientRect();
        this.panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - this.panel.offsetWidth - 12))}px`;
        this.panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - this.panel.offsetHeight - 12))}px`;
    }

    private close(): void {
        if (this.panel.hidden) return;
        const old = this.anchor;
        this.panel.hidden = true;
        this.anchor = null;
        if (old?.isConnected) old.focus();
    }

    private open(
        element: SVGElement,
        entries: string[],
        identity: string,
        implemented: boolean,
    ): void {
        this.anchor = element;
        this.identity = identity;
        this.implemented = implemented;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.onclick = () => this.close();
        const list = document.createElement('ul');
        for (const entry of entries.length === 0
            ? ['No implemented contracts recorded in this saved snapshot.']
            : entries) {
            const item = document.createElement('li');
            item.textContent = entry;
            list.append(item);
        }
        this.panel.replaceChildren(close, list);
        this.panel.hidden = false;
        this.position();
        close.focus({ preventScroll: true });
    }

    private attach(): void {
        for (const group of Array.from(this.host?.querySelectorAll<SVGGElement>('g.edge') ?? [])) {
            const identity = group.querySelector('title')?.textContent ?? '';
            const entries = this.data.edges[identity];
            if (entries === undefined || entries.length === 0) continue;
            const element = group.querySelector('text');
            if (element !== null && element.dataset['wpDetails'] !== 'true')
                this.attachElement(element, entries, identity);
        }
        if (this.panel.hidden || this.anchor?.isConnected) return;
        const groups = Array.from(
            this.host?.querySelectorAll<SVGGElement>(this.implemented ? 'g.node' : 'g.edge') ?? [],
        );
        const group = groups.find(
            (node) => node.querySelector('title')?.textContent === this.identity,
        );
        const replacement = this.implemented ? group : group?.querySelector('text');
        if (replacement) {
            this.anchor = replacement;
            this.position();
        } else this.close();
    }

    private attachElement(element: SVGTextElement, entries: string[], identity: string): void {
        element.dataset['wpDetails'] = 'true';
        element.classList.add('wp-api-detail');
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `Uses: ${identity}`);
        element.setAttribute('aria-haspopup', 'dialog');
        element.addEventListener('click', (event) => {
            event.stopPropagation();
            this.open(element, entries, identity, false);
        });
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.open(element, entries, identity, false);
            }
        });
    }
}
