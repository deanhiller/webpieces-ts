/** An erased vendor interface's qualified identity; this metadata never binds or instantiates an SDK. */
export class ExternalContractUse {
    constructor(public readonly contract: `${string}#${string}`) {}
}
