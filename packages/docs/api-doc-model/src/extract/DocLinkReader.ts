import * as ts from 'typescript';
import { ApiPath, Endpoint, WpMcpTool } from '@webpieces/core-util';
import { DocLink, DocLinkKind, DocLinkText } from '../model/DocLink';
import { SchemaNames } from '../model/SchemaNames';
import { ConstantFolder } from './ConstantFolder';
import { FieldDecorators } from './FieldDecorators';
import { SourceLocation } from './SourceLocation';
import { TypeRegistry } from './TypeRegistry';

/** The decorator names, from the REAL SYMBOLS — see `ApiDocExtractor`'s constants (#1001). */
const API_PATH = ApiPath.name;
const ENDPOINT = Endpoint.name;
const MCP_TOOL = WpMcpTool.name;

/** `https://…`, `mailto:` and friends: a link to the web, not to a declaration. */
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\S*/i;

/** Any of TypeScript's three inline link tags. */
type LinkPart = ts.JSDocLink | ts.JSDocLinkCode | ts.JSDocLinkPlain;

/**
 * One JSDoc `{@link}` -> the text that stands for it in model prose (#1284).
 *
 * The COMPILER resolves the target, so a link means what the editor says it means — an import alias,
 * a qualified name and a `#member` all land on the declaration itself. What it lands on decides what
 * is recorded:
 *
 * | target | recorded as |
 * |---|---|
 * | a class, interface, enum or type alias | {@link DocLinkKind.TYPE}: its model key and published schema name |
 * | a member of one (`MenuDto.items`, `Gender.F`) | {@link DocLinkKind.TYPE} of the owner, the `.member` tail kept as written |
 * | a member written BARE (`{@link storeId}` in a sibling's JSDoc) | {@link DocLinkKind.MEMBER}: the member's published name, no owner prefix |
 * | an `@Endpoint` method of an `@ApiPath` contract | {@link DocLinkKind.OPERATION}: contract, method, `@WpMcpTool` name |
 * | a URL (`{@link https://…}`) | a markdown link, written out here — it names no declaration |
 * | anything else, or nothing | {@link DocLinkKind.UNRESOLVED}, with the reason |
 *
 * Nothing is refused HERE: whether a target is published is a question about one rendered output, so
 * every renderer refuses what it cannot name, naming every offender in one run.
 */
export class DocLinkReader {
    private readonly folder: ConstantFolder;

    constructor(
        private readonly checker: ts.TypeChecker,
        private readonly registry: TypeRegistry,
        private readonly schemaNames: SchemaNames,
    ) {
        this.folder = new ConstantFolder(checker);
    }

    /** The text `part` contributes to a prose string. */
    textOf(part: LinkPart): string {
        const written = part.name?.getText() ?? '';
        const url = DocLinkReader.urlOf(written, part.text);
        if (url !== undefined) {
            return url;
        }
        const label = DocLinkReader.labelOf(part.text);
        return DocLinkText.encode(this.linkOf(part, written, label));
    }

    private linkOf(part: LinkPart, written: string, label: string | undefined): DocLink {
        const location = SourceLocation.of(part);
        const symbol = part.name === undefined ? undefined : this.symbolOf(part.name);
        const declaration = symbol?.declarations?.[0];
        if (declaration === undefined) {
            return DocLinkReader.unresolved(
                written,
                label,
                location,
                'the compiler cannot resolve it — import the target into this file, or fix the name',
            );
        }
        if (DocLinkReader.isNamedType(declaration)) {
            return this.typeLink(declaration, written, label, location, '');
        }
        const owner = DocLinkReader.ownerOf(declaration);
        if (DocLinkReader.isNamedType(owner)) {
            if (ts.isClassDeclaration(owner) && FieldDecorators.hasDecorator(owner, API_PATH)) {
                return this.operationLink(owner, declaration, written, label, location);
            }
            const bare = DocLinkReader.bareMemberName(part.name!, declaration);
            if (bare !== undefined) {
                return this.memberLink(owner, bare, written, label, location);
            }
            return this.typeLink(owner, written, label, location, DocLinkReader.tailOf(part.name!));
        }
        return DocLinkReader.unresolved(
            written,
            label,
            location,
            'it names neither a published type nor a contract operation',
        );
    }

    private typeLink(
        declaration: NamedTypeDeclaration,
        written: string,
        label: string | undefined,
        location: string,
        member: string,
    ): DocLink {
        if (
            ts.isClassDeclaration(declaration) &&
            FieldDecorators.hasDecorator(declaration, API_PATH)
        ) {
            return DocLinkReader.unresolved(
                written,
                label,
                location,
                'a contract class is not published under its own name — link one of its methods',
            );
        }
        const name = declaration.name!.text;
        return new DocLink(
            DocLinkKind.TYPE,
            written,
            label,
            location,
            this.registry.keyFor(name, declaration),
            this.schemaNames.nameOf(name, declaration.getSourceFile().fileName),
            member,
            undefined,
            '',
        );
    }

    /**
     * A member written bare (#1308). TypeScript resolves `{@link storeId}` in a member's JSDoc to the
     * property of the enclosing class or interface — its own, or one it inherits — so the owner here is
     * the type that DECLARES it, which may be a base the document flattens away. Nothing about that
     * owner is checked: the published name is the member's own, read the way the field is.
     */
    private memberLink(
        owner: NamedTypeDeclaration,
        member: string,
        written: string,
        label: string | undefined,
        location: string,
    ): DocLink {
        const name = owner.name.text;
        return new DocLink(
            DocLinkKind.MEMBER,
            written,
            label,
            location,
            this.registry.keyFor(name, owner),
            this.schemaNames.nameOf(name, owner.getSourceFile().fileName),
            member,
            undefined,
            '',
        );
    }

    private operationLink(
        contract: ts.ClassDeclaration,
        member: ts.Declaration,
        written: string,
        label: string | undefined,
        location: string,
    ): DocLink {
        if (!ts.isMethodDeclaration(member) || !FieldDecorators.hasDecorator(member, ENDPOINT)) {
            return DocLinkReader.unresolved(
                written,
                label,
                location,
                `it names a member of contract ${contract.name?.text ?? '<anonymous>'} that is not an @${ENDPOINT} method`,
            );
        }
        const tool = FieldDecorators.decoratorCall(member, MCP_TOOL)?.arguments[0];
        return new DocLink(
            DocLinkKind.OPERATION,
            written,
            label,
            location,
            contract.name?.text ?? '<anonymous>',
            member.name.getText(),
            '',
            tool === undefined ? undefined : this.folder.tryFoldString(tool),
            '',
        );
    }

    /** The declaration's symbol, through an import alias; a `#member` resolves on its right side. */
    private symbolOf(name: ts.EntityName | ts.JSDocMemberName): ts.Symbol | undefined {
        const symbol =
            this.checker.getSymbolAtLocation(name) ??
            (ts.isJSDocMemberName(name) ? this.checker.getSymbolAtLocation(name.right) : undefined);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            return this.checker.getAliasedSymbol(symbol);
        }
        return symbol;
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static isNamedType(node: ts.Node | undefined): node is NamedTypeDeclaration {
        return (
            node !== undefined &&
            (ts.isClassDeclaration(node) ||
                ts.isInterfaceDeclaration(node) ||
                ts.isEnumDeclaration(node) ||
                ts.isTypeAliasDeclaration(node)) &&
            node.name !== undefined
        );
    }

    /** The type a member belongs to — through a type literal to the alias that names it. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static ownerOf(member: ts.Declaration): ts.Node | undefined {
        const parent = member.parent;
        return ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)
            ? parent.parent
            : parent;
    }

    /**
     * The published name of a member the link names BARE — an identifier, not `Type.member` /
     * `Type#member` — read exactly as `TypeResolver` names a field (an identifier's or a quoted
     * name's text; nothing renames a property on the wire). Undefined when the link is qualified or
     * the member has no such name.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static bareMemberName(
        name: ts.EntityName | ts.JSDocMemberName,
        member: ts.Declaration,
    ): string | undefined {
        if (!ts.isIdentifier(name)) {
            return undefined;
        }
        const memberName = (member as ts.NamedDeclaration).name;
        if (
            memberName === undefined ||
            (!ts.isIdentifier(memberName) && !ts.isStringLiteral(memberName))
        ) {
            return undefined;
        }
        return memberName.text;
    }

    /** `.items` of `MenuDto.items`, `#items` of `MenuDto#items` — the tail exactly as written. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static tailOf(name: ts.EntityName | ts.JSDocMemberName): string {
        if (ts.isQualifiedName(name)) {
            return `.${name.right.text}`;
        }
        if (ts.isJSDocMemberName(name)) {
            return `#${name.right.text}`;
        }
        return '';
    }

    /**
     * `{@link https://x | Example}` -> `[Example](https://x)`, `{@link https://x}` -> `<https://x>`.
     * TypeScript reads the scheme as the link's NAME and the rest as its text, so the URL is rebuilt.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static urlOf(written: string, text: string): string | undefined {
        const raw = `${written}${text}`.trim();
        if (!URL_TARGET.test(raw) || !raw.startsWith(`${written}:`)) {
            return undefined;
        }
        const pipe = raw.indexOf('|');
        const url = pipe >= 0 ? raw.slice(0, pipe).trim() : (raw.split(/\s/)[0] ?? raw);
        const label = DocLinkReader.labelOf(
            pipe >= 0 ? raw.slice(pipe + 1) : raw.slice(url.length),
        );
        return label === undefined ? `<${url}>` : `[${label}](${url})`;
    }

    /** `| the label` / ` the label` -> `the label`; nothing -> undefined. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static labelOf(text: string): string | undefined {
        const label = text.replace(/^[|\s]+/, '').trim();
        return label === '' ? undefined : label;
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static unresolved(
        written: string,
        label: string | undefined,
        location: string,
        reason: string,
    ): DocLink {
        return new DocLink(
            DocLinkKind.UNRESOLVED,
            written,
            label,
            location,
            '',
            '',
            '',
            undefined,
            reason,
        );
    }
}

/** A declaration that names a type a document can publish. */
type NamedTypeDeclaration = (
    | ts.ClassDeclaration
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration
    | ts.TypeAliasDeclaration
) & { name: ts.Identifier };
