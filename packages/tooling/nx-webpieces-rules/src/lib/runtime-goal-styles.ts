import { RuntimeDiffStatus } from './runtime-graph-diff';

/** One status's colors. Text color stays readable on the fill. */
export class DiffStyle {
    constructor(
        public readonly fill: string,
        public readonly border: string,
        public readonly text: string,
        public readonly word: string,
    ) {}
}

export const DIFF_STYLES: Record<RuntimeDiffStatus, DiffStyle> = {
    [RuntimeDiffStatus.ADDED]: new DiffStyle('#c9f0d3', '#1f8a3b', '#1a1c22', 'added in goal'),
    [RuntimeDiffStatus.REMOVED]: new DiffStyle('#fde0e0', '#c62828', '#7a1c1c', 'removed from goal'),
    [RuntimeDiffStatus.CHANGED]: new DiffStyle('#fde7b0', '#d88a00', '#1a1c22', 'changed'),
    [RuntimeDiffStatus.UNCHANGED]: new DiffStyle('#eef0f4', '#b4b9c4', '#6b7180', 'unchanged'),
};
