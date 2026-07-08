/**
 * LoggedError - the serialized shape of an Error as it appears in a bunyan log
 * record's `err` field. Data-only structure → a class, per CLAUDE.md. Produced by
 * BunyanLogger's error normalization and read back by the console formatter.
 */
export class LoggedError {
    constructor(
        public readonly name: string,
        public readonly message: string,
        public readonly stack?: string,
    ) {}
}
