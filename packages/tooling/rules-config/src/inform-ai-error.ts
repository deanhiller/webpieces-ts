export class InformAiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InformAiError';
    }
}
