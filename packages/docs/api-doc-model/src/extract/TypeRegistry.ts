import * as ts from 'typescript';
import {
    DocumentedField,
    DocumentedType,
    TypeNameCollision,
    UnionDiscriminator,
} from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { PackageOfFile } from './PackageOfFile';
import { SourceLocation } from './SourceLocation';

/**
 * The named types a {@link TypeResolver} has registered, by KEY (#1058): the bare name for a type the
 * HOME package declares, `<package>:<name>` for any other ({@link DocumentedType.keyOf}).
 *
 * It also remembers which DECLARATION claimed each key, so a second, different declaration arriving
 * under it — two `DupDto`s in one package — is recorded as a {@link TypeNameCollision} rather than
 * silently standing in for the first. The resolver still resolves it to the first, exactly as before,
 * so the MCP projection is unchanged; an OpenAPI document refuses the model.
 */
export class TypeRegistry {
    readonly types = new Map<string, DocumentedType>();
    readonly collisions: TypeNameCollision[] = [];
    /** Named types already registered (or mid-registration) — the cycle stop for the NAMED case. */
    readonly registered = new Set<string>();
    /** The DECLARATION each key was claimed by, so a second, different one is noticed. */
    readonly claimedBy = new Map<string, ts.Node>();

    constructor(
        private readonly packages: PackageOfFile,
        private readonly homePackage: string | undefined,
    ) {}

    /** The key `name`, declared at `node`, is registered under. */
    keyFor(name: string, node: ts.Node): string {
        return DocumentedType.keyOf(name, this.packageOf(node), this.homePackage);
    }

    private packageOf(node: ts.Node): string | undefined {
        return this.packages.of(node.getSourceFile().fileName)?.name;
    }

    /**
     * True when `key` is already registered, recording a {@link TypeNameCollision} when `declaration`
     * is not the one that claimed it. False claims the key for `declaration`.
     */
    alreadyRegistered(key: string, name: string, declaration: ts.Node): boolean {
        if (!this.registered.has(key)) {
            this.claimedBy.set(key, declaration);
            return false;
        }
        const first = this.claimedBy.get(key);
        if (first !== undefined && first !== declaration) {
            this.noteCollision(name, first, declaration);
        }
        return true;
    }

    private noteCollision(name: string, first: ts.Node, second: ts.Node): void {
        const firstLocation = SourceLocation.of(first);
        const secondLocation = SourceLocation.of(second);
        const seen = this.collisions.some(
            (each: TypeNameCollision) =>
                each.name === name &&
                each.firstLocation === firstLocation &&
                each.secondLocation === secondLocation,
        );
        if (!seen) {
            this.collisions.push(
                new TypeNameCollision(name, this.packageOf(second), firstLocation, secondLocation),
            );
        }
    }

    /** A {@link DocumentedType} carrying the declaring package and location of `declaration`. */
    documented(
        name: string,
        declaration: ts.Node,
        description: string,
        fields: readonly DocumentedField[],
        enumValues: readonly string[],
        unionRefNames: readonly string[],
        discriminator: UnionDiscriminator | undefined,
        indexSignatureValue: TypeRef | undefined,
    ): DocumentedType {
        return new DocumentedType(
            name,
            description,
            fields,
            enumValues,
            unionRefNames,
            discriminator,
            indexSignatureValue,
            this.packageOf(declaration),
            SourceLocation.of(declaration),
        );
    }
}
