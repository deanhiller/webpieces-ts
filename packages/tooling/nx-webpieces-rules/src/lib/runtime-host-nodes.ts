/**
 * Who dials ONE runtime destination, and through which contracts — the accumulator behind
 * `RuntimeGraphDeriver.recordRuntimeHost`. A class rather than an object literal, per this repo's
 * rule, and Sets rather than arrays because two call sites in one service naming the same partner
 * identity are one arrow, not two.
 */
export class RuntimeHostUsage {
    readonly usedBy = new Set<string>();
    readonly apis = new Set<string>();
}
