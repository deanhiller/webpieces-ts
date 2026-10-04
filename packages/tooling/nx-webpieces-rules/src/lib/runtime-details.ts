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

    constructor(graph: RuntimeGraph, showExternalNodes: boolean) {
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
                if (ref.conditional !== undefined)
                    implemented.push(`${ref.api} conditional on ${ref.conditional}`);
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
    }

    script(): string {
        const encoded = JSON.stringify(this).replace(/</g, '\\u003c');
        return `new (${RuntimeDetailsController.toString()})(${encoded});`;
    }
}

/** Serialized native DOM controller; no application or framework dependencies. */
class RuntimeDetailsController {
    private readonly host = document.getElementById('graph');
    private readonly panel = document.createElement('div');
    private anchor: SVGTextElement | null = null;
    private pinned = false;
    private suppressFocus = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly data: RuntimeDetails) {
        if (this.host === null) return;
        this.panel.className = 'wp-graph-details';
        this.panel.hidden = true;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'API relationships');
        document.body.append(this.panel);
        this.panel.addEventListener('pointerenter', () => clearTimeout(this.timer));
        this.panel.addEventListener('pointerleave', () => this.later());
        new MutationObserver(() => this.attach()).observe(this.host, { childList: true });
        this.attach();
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.close();
        });
        document.addEventListener('click', (event) => {
            if (event.target instanceof Node && !this.panel.contains(event.target)) this.hide();
        });
        document.addEventListener('wp-graph-transform', () => this.position());
    }

    private position(): void {
        if (this.anchor === null || this.panel.hidden) return;
        const rect = this.anchor.getBoundingClientRect();
        this.panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - this.panel.offsetWidth - 12))}px`;
        this.panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - this.panel.offsetHeight - 12))}px`;
    }

    private hide(): void {
        this.panel.hidden = true;
        this.pinned = false;
        this.anchor = null;
    }

    private close(): void {
        const old = this.anchor;
        this.suppressFocus = true;
        this.hide();
        old?.focus();
        this.suppressFocus = false;
    }

    private later(): void {
        if (!this.pinned) this.timer = setTimeout(() => this.hide(), 250);
    }

    private open(element: SVGTextElement, entries: string[], pin: boolean): void {
        clearTimeout(this.timer);
        this.pinned = pin;
        this.anchor = element;
        this.panel.replaceChildren();
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.onclick = () => this.close();
        const list = document.createElement('ul');
        for (const entry of entries) {
            const item = document.createElement('li');
            item.textContent = entry;
            list.append(item);
        }
        this.panel.append(close, list);
        this.panel.hidden = false;
        this.position();
    }

    private attach(): void {
        for (const element of Array.from(
            this.host?.querySelectorAll<SVGTextElement>('g.node text, g.edge text') ?? [],
        )) {
            if (element.dataset['wpDetails'] === 'true') continue;
            const identity = element.parentElement?.querySelector('title')?.textContent ?? '';
            const label = element.textContent ?? '';
            const node = this.data.nodes[identity];
            const entries = label.startsWith('Implements (')
                ? node?.implemented
                : label.startsWith('Uses (')
                  ? (node?.used ?? this.data.edges[identity])
                  : undefined;
            if (entries !== undefined) this.attachElement(element, entries);
        }
    }

    private attachElement(element: SVGTextElement, entries: string[]): void {
        element.dataset['wpDetails'] = 'true';
        element.classList.add('wp-api-detail');
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-haspopup', 'dialog');
        element.addEventListener('pointerenter', () => {
            if (!this.pinned) this.open(element, entries, false);
        });
        element.addEventListener('pointerleave', () => this.later());
        element.addEventListener('focus', () => {
            if (!this.pinned && !this.suppressFocus) this.open(element, entries, false);
        });
        element.addEventListener('click', (event) => {
            event.stopPropagation();
            this.open(element, entries, true);
        });
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.open(element, entries, true);
            }
        });
    }
}
