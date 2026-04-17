// @webpieces/dev-config Angular ESLint Configuration
// This is the canonical template for Angular projects using external clients
//
// IMPORTANT: When modifying rules here, also update:
// - /eslint.webpieces-angular.config.mjs (webpieces workspace version with loadWorkspaceRules)
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ NOT USING ANGULAR?                                                      │
// │   1. Delete this file                                                   │
// │   2. Remove its import from eslint.config.mjs                          │
// └─────────────────────────────────────────────────────────────────────────┘
//
// SETUP: Replace the placeholder paths below with your actual source paths:
//   YOUR_CLIENT_PATH  →  e.g. services/website/client
//   YOUR_SERVER_PATH  →  e.g. services/website/server

import webpiecesPlugin from '@webpieces/eslint-rules';
import angularTemplatePlugin from '@angular-eslint/eslint-plugin-template';
import angularTemplateParser from '@angular-eslint/template-parser';

export default [
    // ─── Angular HTML template rules ────────────────────────────────────────
    // Applies to all Angular HTML template files
    {
        files: ['**/*.html'],
        languageOptions: {
            parser: angularTemplateParser,
        },
        plugins: {
            '@webpieces': webpiecesPlugin,
            '@angular-eslint/template': angularTemplatePlugin,
        },
        rules: {
            // Require [templateClassType] on <ng-template> with let- variables
            '@webpieces/require-typed-template': 'error',
            // Ban *matCellDef/*matHeaderCellDef — use div-grid tables instead
            '@webpieces/no-mat-cell-def': 'error',
            // Enforce modern Angular control flow (@if, @for, @switch)
            '@angular-eslint/template/prefer-control-flow': 'error',
            // Accessibility rules — adjust to your project's needs
            '@angular-eslint/template/click-events-have-key-events': 'off',
            '@angular-eslint/template/interactive-supports-focus': 'off',
            '@angular-eslint/template/alt-text': 'off',
            '@angular-eslint/template/label-has-associated-control': 'off',
        },
    },

    // ─── Angular client TypeScript rules ────────────────────────────────────
    // Replace YOUR_CLIENT_PATH with your client source path (e.g. services/website/client)
    {
        files: ['YOUR_CLIENT_PATH/**/*.ts', 'YOUR_CLIENT_PATH/**/*.tsx'],
        rules: {
            // Prevent console.log leaking to the browser
            'no-console': 'error',
        },
    },
    {
        files: ['YOUR_CLIENT_PATH/**/*.ts', 'YOUR_CLIENT_PATH/**/*.tsx'],
        rules: {
            'no-restricted-syntax': [
                'error',
                // Ban this.route.data — use the service pattern instead
                {
                    selector:
                        'MemberExpression[object.type="MemberExpression"][object.object.type="ThisExpression"][object.property.name="route"][property.name="data"]',
                    message:
                        'Do not use this.route.data — use the service pattern instead. ' +
                        'The service pattern is more flexible, allowing other components to listen as well.',
                },
                // Ban async ngOnInit — Angular does NOT await the Promise return value
                {
                    selector: 'MethodDefinition[key.name="ngOnInit"][value.async=true]',
                    message:
                        'async ngOnInit() is NOT allowed — Angular does NOT await the Promise return value! ' +
                        'Use resolvers for data loading, not async ngOnInit.',
                },
                // Ban Angular signals — use plain class properties with RxJS subscriptions
                {
                    selector: 'CallExpression[callee.name="signal"]',
                    message:
                        'Angular signal() is banned. Use plain class properties set in ngOnInit via RxJS subscriptions. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="computed"]',
                    message:
                        'Angular computed() is banned. Use getter methods or update properties in ngOnInit subscriptions. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="effect"]',
                    message:
                        'Angular effect() is banned. Use RxJS subscriptions in ngOnInit instead. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="model"]',
                    message:
                        'Angular model() is banned. Use plain class properties with RxJS. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="input"]',
                    message:
                        'Angular signal-based input() is banned. Use @Input() decorator instead. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="output"]',
                    message:
                        'Angular signal-based output() is banned. Use @Output() decorator instead. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'CallExpression[callee.name="toSignal"]',
                    message:
                        'Angular toSignal() is banned. Keep using RxJS observables with subscriptions in ngOnInit. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'TSTypeReference[typeName.name="Signal"]',
                    message:
                        'Signal type is banned. Use plain property types instead. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                {
                    selector: 'TSTypeReference[typeName.name="WritableSignal"]',
                    message:
                        'WritableSignal type is banned. Use plain property types instead. ' +
                        'Use eslint-disable-next-line no-restricted-syntax for case-by-case exceptions.',
                },
                // Ban direct Sentry.captureException — use your wrapper function instead
                {
                    selector:
                        'CallExpression[callee.object.name="Sentry"][callee.property.name="captureException"]',
                    message:
                        'Direct Sentry.captureException() is banned. ' +
                        'Use your reportSentryError() wrapper function instead.',
                },
            ],
        },
    },
    // Ban MatTableModule — use div-grid tables instead
    {
        files: ['YOUR_CLIENT_PATH/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: '@angular/material/table',
                            message:
                                'MatTableModule is banned. Use the div-grid table pattern instead. ' +
                                'Div-grid tables are inherently type-safe with @for loops + strictTemplates.',
                        },
                    ],
                },
            ],
        },
    },

    // ─── Server TypeScript rules ─────────────────────────────────────────────
    // Replace YOUR_SERVER_PATH with your server source path (e.g. services/website/server)
    {
        files: ['YOUR_SERVER_PATH/**/*.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                // Ban direct Sentry.captureException — use your wrapper function instead
                {
                    selector:
                        'CallExpression[callee.object.name="Sentry"][callee.property.name="captureException"]',
                    message:
                        'Direct Sentry.captureException() is banned. ' +
                        'Use your reportSentryException() wrapper function instead.',
                },
            ],
        },
    },

    // ─── TypeScript preferences ──────────────────────────────────────────────
    {
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
            '@typescript-eslint/no-inferrable-types': 'off',
        },
    },
];
