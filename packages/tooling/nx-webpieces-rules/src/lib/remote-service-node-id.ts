/**
 * The DOT/node identity of a reviewed remote service (#1203). Prefixed so it can never collide with a
 * workspace service node (whose identity is its project key), and reduced to DOT-safe characters like
 * every other synthetic node id. One owner so the drawing and the detail panel agree on the id.
 */
export class RemoteServiceNodeId {
    of(name: string): string {
        return `remote__${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
    }
}
