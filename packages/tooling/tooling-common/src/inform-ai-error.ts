export class InformAiError extends Error {
    override cause?: Error;

    constructor(message: string, options?: { cause?: Error }) {
        super(message);
        this.name = 'InformAiError';
        this.cause = options?.cause;
    }
}
