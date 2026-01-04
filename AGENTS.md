# ACP Provider Agent Guide

1. **Build**: `npm run compile`; **watch**: `npm run watch`.
2. **Lint**: `npm run lint` (Prettier check); **format**: `npm run format`.
3. **Tests**: none defined; compile verifies types before publishing.
4. **Single test**: not available—run `npm run compile` for validation.
5. **Packaging**: `npm run package` builds the VSIX.
6. **Type safety**: Strict TS (`strict: true`, `esModuleInterop`, `ES2024`).
7. **Imports**: Prefer explicit relative paths within `src`; keep groupings (built-ins, deps, local) with blank lines.
8. **Formatting**: Use Prettier defaults (`.prettierrc`), 2 spaces, double quotes.
9. **Naming**: PascalCase for classes/types, camelCase for functions/variables, UPPER_SNAKE for constants.
10. **Types**: Avoid `any`; lean on SDK types and VS Code APIs.
11. **Async**: Always `await` async calls; respect cancellation tokens.
12. **Disposables**: Extend `DisposableBase`, register disposables promptly.
13. **Docs**: Update `README.md` when adding commands or settings.
