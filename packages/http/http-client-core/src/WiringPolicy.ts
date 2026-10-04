/** Named runtime policy; extraction persists its condition, never the resolved environment value. */
export class WiringPolicy {
    constructor(
        public readonly name: string,
        public readonly enabled: boolean,
    ) {}
}
