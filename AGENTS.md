# AGENTS.md

## Project Overview

VSCode extension ("SQL All in One") providing SQL formatting, linting, completion, database connections, and DDL conversion for 12 SQL dialects. Publisher: bryce-qin.

## Build & Test Commands

```bash
# Development
npm run compile          # TypeScript compilation (tsc)
npm run watch            # Watch mode for tsc
npm run esbuild          # Generate snippets + esbuild bundle (dev)
npm run lint             # ESLint on src/

# Testing (requires display - runs in vscode-test)
npm test                 # Runs pretest (compile + lint) then vscode-test
npm run test:coverage    # With nyc coverage

# Production
npm run vscode:prepublish  # Generate snippets + esbuild --minify
```

**CI order**: `npm ci` → `npx tsc --noEmit` → `npm run lint` → `npm run vscode:prepublish` → `xvfb-run -a npm test`

## Key Architecture

- **Entry**: `src/extension.ts` → `out/extension.js`
- **Bundle**: esbuild bundles everything except native modules (`pg`, `better-sqlite3`, `mssql`, `oracledb`, `odbc`, `mysql2`, `ssh2`, `node-sql-parser`, `vscode`)
- **DI Container**: `src/core/diContainer.ts` manages singletons
- **Tests**: `src/test/**/*.test.ts` → compiled to `out/test/`
- **ESLint ignore**: `src/parser/grammar.ts` is excluded from linting

## Development Notes

- Native modules (odbc, better-sqlite3, etc.) require C++ build tools on first install
- Test timeout: 60000ms (configured in `.vscode-test.js`)
- Snippets auto-generated from `scripts/generate-snippets.ts` before builds
- Extension activates on all 12 SQL language IDs + many commands
