import type { EnhancedGraph } from './graph-sorter';

/** Render options for the runtime graph. */
export class RuntimeVizOptions {
    constructor(
        /**
         * Draw the dashed terminal nodes for contracts nothing in-repo implements. On by default;
         * a repo whose external surface is noisy can turn them off in the declared Nx owner file's
         * direct policy-ID map (runtime-architecture.showExternalNodes).
         */
        public readonly showExternalNodes: boolean = true,
        public readonly projects: EnhancedGraph | null = null,
        public readonly workspaceRoot: string = '',
    ) {}
}

