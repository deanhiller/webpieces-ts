// @webpieces/nx-webpieces-rules Angular ESLint Configuration for webpieces-ts workspace
//
// IMPORTANT: This file must stay in sync with:
// - packages/tooling/nx-webpieces-rules/templates/eslint.webpieces-angular.config.mjs (canonical template)
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ NOT USING ANGULAR?                                                      │
// │   1. Delete this file                                                   │
// │   2. Remove its import from eslint.config.mjs                          │
// └─────────────────────────────────────────────────────────────────────────┘

import { loadWorkspaceRules } from '@nx/eslint-plugin';
import angularTemplatePlugin from '@angular-eslint/eslint-plugin-template';
import angularTemplateParser from '@angular-eslint/template-parser';

const webpiecesRules = await loadWorkspaceRules(
    'packages/tooling/eslint-rules/src',
    'packages/tooling/eslint-rules/tsconfig.lib.json'
);

const webpiecesPlugin = { rules: webpiecesRules };

export default [
    // ─── Angular HTML template rules ────────────────────────────────────────
    {
        files: ['apps/example-client/**/*.html'],
        languageOptions: {
            parser: angularTemplateParser,
        },
        plugins: {
            '@webpieces': webpiecesPlugin,
            '@angular-eslint/template': angularTemplatePlugin,
        },
        rules: {
            '@webpieces/require-typed-template': 'error',
            '@webpieces/no-mat-cell-def': 'error',
            '@angular-eslint/template/prefer-control-flow': 'error',
            '@angular-eslint/template/click-events-have-key-events': 'off',
            '@angular-eslint/template/interactive-supports-focus': 'off',
            '@angular-eslint/template/alt-text': 'off',
            '@angular-eslint/template/label-has-associated-control': 'off',
        },
    },

    // ─── Angular client TypeScript rules ────────────────────────────────────
    {
        files: ['apps/example-client/**/*.ts'],
        rules: {
            'no-console': 'error',
        },
    },
    {
        files: ['apps/example-client/**/*.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'MemberExpression[object.type="MemberExpression"][object.object.type="ThisExpression"][object.property.name="route"][property.name="data"]',
                    message:
                        'Do not use this.route.data — use the service pattern instead. ' +
                        'The service pattern is more flexible, allowing other components to listen as well.',
                },
                {
                    selector: 'MethodDefinition[key.name="ngOnInit"][value.async=true]',
                    message:
                        'async ngOnInit() is NOT allowed — Angular does NOT await the Promise return value! ' +
                        'Use resolvers for data loading, not async ngOnInit.',
                },
                {
                    selector: 'CallExpression[callee.name="signal"]',
                    message:
                        'Angular signal() is banned. Use plain class properties set in ngOnInit via RxJS subscriptions.',
                },
                {
                    selector: 'CallExpression[callee.name="computed"]',
                    message:
                        'Angular computed() is banned. Use getter methods or update properties in ngOnInit subscriptions.',
                },
                {
                    selector: 'CallExpression[callee.name="effect"]',
                    message:
                        'Angular effect() is banned. Use RxJS subscriptions in ngOnInit instead.',
                },
                {
                    selector: 'CallExpression[callee.name="model"]',
                    message: 'Angular model() is banned. Use plain class properties with RxJS.',
                },
                {
                    selector: 'CallExpression[callee.name="input"]',
                    message:
                        'Angular signal-based input() is banned. Use @Input() decorator instead.',
                },
                {
                    selector: 'CallExpression[callee.name="output"]',
                    message:
                        'Angular signal-based output() is banned. Use @Output() decorator instead.',
                },
                {
                    selector: 'CallExpression[callee.name="toSignal"]',
                    message:
                        'Angular toSignal() is banned. Keep using RxJS observables with subscriptions in ngOnInit.',
                },
                {
                    selector: 'TSTypeReference[typeName.name="Signal"]',
                    message: 'Signal type is banned. Use plain property types instead.',
                },
                {
                    selector: 'TSTypeReference[typeName.name="WritableSignal"]',
                    message: 'WritableSignal type is banned. Use plain property types instead.',
                },
            ],
        },
    },
    {
        files: ['apps/example-client/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: '@angular/material/table',
                            message:
                                'MatTableModule is banned. Use the div-grid table pattern instead.',
                        },
                    ],
                },
            ],
        },
    },

    // ─── TypeScript preferences ──────────────────────────────────────────────
    {
        files: ['apps/example-client/**/*.ts'],
        rules: {
            '@typescript-eslint/no-inferrable-types': 'off',
        },
    },
];
