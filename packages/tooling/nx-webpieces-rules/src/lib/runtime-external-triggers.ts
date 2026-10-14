import type { RuntimeTrigger } from './runtime-graph-model';

/** One external caller/service pair, shared by DOT emission and popup data. */
export class RuntimeExternalTriggerGroup {
    readonly triggers: RuntimeTrigger[] = [];

    constructor(
        readonly from: string,
        readonly to: string,
    ) {}

    apis(): string[] {
        return [...new Set(this.triggers.map((trigger: RuntimeTrigger) => trigger.api))].sort();
    }

    label(): string {
        const apis = this.apis();
        if (apis.length > 1) return `Uses (${apis.length}) ▾`;
        const methods = new Set(this.triggers.map((trigger: RuntimeTrigger) => trigger.method));
        return methods.size === 1 ? `${apis[0]}.${this.triggers[0].method}` : apis[0];
    }
}

export class RuntimeExternalTriggers {
    readonly groups: RuntimeExternalTriggerGroup[];

    constructor(triggers: RuntimeTrigger[]) {
        const groups = new Map<string, RuntimeExternalTriggerGroup>();
        for (const trigger of triggers) {
            if (trigger.kind !== 'external') continue;
            const caller = trigger.caller;
            const from =
                caller === undefined
                    ? `inbound__${trigger.api.replace(/[^A-Za-z0-9_]/g, '_')}`
                    : `system__caller__${caller.label.replace(/[^A-Za-z0-9_]/g, '_')}`;
            const key = JSON.stringify([from, trigger.service]);
            if (!groups.has(key))
                groups.set(key, new RuntimeExternalTriggerGroup(from, trigger.service));
            groups.get(key)!.triggers.push(trigger);
        }
        this.groups = [...groups.values()];
    }
}
