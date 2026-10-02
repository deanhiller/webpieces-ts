import * as ts from 'typescript';
import { StreamDirection, WpStream } from '@webpieces/core-util';
import { TypeRef } from '../model/TypeRef';
import { TypeResolver } from './TypeResolver';
import { ConstantFolder } from './ConstantFolder';
import { SourceLocation } from './SourceLocation';
import { ApiDocExtractionError } from './ApiDocExtractionError';

export class DocumentedStreaming {
    constructor(
        readonly direction: StreamDirection,
        readonly initialRequest: TypeRef,
        readonly initialResponse: TypeRef,
        readonly requestEvent: TypeRef | undefined,
        readonly responseEvent: TypeRef | undefined,
    ) {}
}

const FORMS = [
    'FULL: (InitialRequest, ResponseStream<ResponseEvent>) => Promise<RequestStream<InitialResponse, RequestEvent>>',
    'RESPONSE: (InitialRequest, ResponseStream<ResponseEvent>) => Promise<InitialResponse>',
    'REQUEST: (InitialRequest) => Promise<RequestStream<InitialResponse, RequestEvent>>',
].join('\n');

/** Derives the four independent schema slots from the declaration, refusing every mismatched form. */
export class StreamingSignature {
    read(
        method: ts.MethodDeclaration,
        folder: ConstantFolder,
        resolver: TypeResolver,
    ): DocumentedStreaming | undefined {
        const call = this.decorator(method);
        if (!call) return undefined;
        const selected = this.direction(method, call, folder);
        const initialRequest = method.parameters[0].type;
        if (
            !initialRequest ||
            method.parameters[0].questionToken ||
            method.parameters[0].dotDotDotToken
        ) {
            this.invalid(
                method,
                selected,
                'Parameter 1 must declare a required InitialRequest DTO.',
            );
        }
        const returned = this.generic(
            method.type,
            'Promise',
            1,
            method,
            selected,
            'return type',
        )[0];
        const requestTypes =
            selected === StreamDirection.RESPONSE
                ? undefined
                : this.generic(returned, 'RequestStream', 2, method, selected, 'return type');
        const initialResponse = requestTypes ? requestTypes[0] : returned;
        if (
            selected === StreamDirection.RESPONSE &&
            ts.isTypeReferenceNode(returned) &&
            ['RequestStream', 'ResponseStream'].includes(returned.typeName.getText())
        ) {
            this.invalid(
                method,
                selected,
                'return type must resolve to InitialResponse, not a stream.',
            );
        }
        this.requireDto(initialResponse, method, selected, 'initial response');
        const responseEvent =
            selected === StreamDirection.REQUEST
                ? undefined
                : this.generic(
                      method.parameters[1].type,
                      'ResponseStream',
                      1,
                      method,
                      selected,
                      'parameter 2',
                  )[0];
        this.requireDto(initialRequest, method, selected, 'initial request');
        if (requestTypes) this.requireDto(requestTypes[1], method, selected, 'request event');
        if (responseEvent) this.requireDto(responseEvent, method, selected, 'response event');
        const owner = method.name.getText();
        return new DocumentedStreaming(
            selected,
            resolver.resolve(initialRequest, `${owner}.initialRequest`),
            resolver.resolve(initialResponse, `${owner}.initialResponse`),
            requestTypes ? resolver.resolve(requestTypes[1], `${owner}.requestEvent`) : undefined,
            responseEvent ? resolver.resolve(responseEvent, `${owner}.responseEvent`) : undefined,
        );
    }

    private direction(
        method: ts.MethodDeclaration,
        call: ts.CallExpression,
        folder: ConstantFolder,
    ): StreamDirection {
        if (call.arguments.length !== 1)
            this.invalid(method, 'unknown', 'Decorator requires direction only.');
        const direction = folder.foldString(call.arguments[0], '@WpStream direction');
        if (!Object.values(StreamDirection).includes(direction as StreamDirection)) {
            this.invalid(method, direction, 'Unknown stream direction.');
        }
        const selected = direction as StreamDirection;
        const expected = selected === StreamDirection.REQUEST ? 1 : 2;
        if (method.parameters.length !== expected) {
            this.invalid(
                method,
                selected,
                `Expected ${expected} parameter(s); incorrect parameter ${expected + 1}.`,
            );
        }
        return selected;
    }

    private generic(
        node: ts.TypeNode | undefined,
        name: string,
        count: number,
        method: ts.MethodDeclaration,
        direction: string,
        position: string,
    ): readonly ts.TypeNode[] {
        if (
            !node ||
            !ts.isTypeReferenceNode(node) ||
            node.typeName.getText() !== name ||
            node.typeArguments?.length !== count
        ) {
            this.invalid(
                method,
                direction,
                `${position} must use ${name} with exactly ${count} generic type(s).`,
            );
        }
        return node.typeArguments;
    }

    private requireDto(
        node: ts.TypeNode,
        method: ts.MethodDeclaration,
        direction: string,
        slot: string,
    ): void {
        if (
            node.kind === ts.SyntaxKind.VoidKeyword ||
            node.kind === ts.SyntaxKind.NeverKeyword ||
            node.kind === ts.SyntaxKind.AnyKeyword ||
            node.kind === ts.SyntaxKind.UnknownKeyword ||
            (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) ||
            (ts.isUnionTypeNode(node) &&
                node.types.some(
                    (part: ts.TypeNode): boolean =>
                        part.kind === ts.SyntaxKind.UndefinedKeyword ||
                        (ts.isLiteralTypeNode(part) &&
                            part.literal.kind === ts.SyntaxKind.NullKeyword),
                ))
        )
            this.invalid(method, direction, `${slot} must be a non-null client-defined DTO type.`);
    }

    private decorator(method: ts.MethodDeclaration): ts.CallExpression | undefined {
        for (const decorator of ts.getDecorators(method) ?? []) {
            const expression = decorator.expression;
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText() === WpStream.name
            )
                return expression;
        }
        return undefined;
    }

    private invalid(method: ts.MethodDeclaration, direction: string, reason: string): never {
        const owner = ts.isClassDeclaration(method.parent)
            ? method.parent.name?.getText()
            : '<anonymous>';
        throw new ApiDocExtractionError(
            `Invalid @WpStream(StreamDirection.${direction.toUpperCase()}) method ${owner}.${method.name.getText()}: ${reason}`,
            SourceLocation.of(method),
            `Supported forms:\n${FORMS}`,
        );
    }
}
