# Repository Guidelines

## Project Structure and Module Organization
Source lives in `src/`, with API resource clients and serialization under `src/api/`, shared helpers in `src/core/`, errors in `src/errors/`, and shared types in `src/types/`. Entry points are `src/index.ts` and `src/Client.ts`. Tests live in `tests/` with unit coverage in `tests/unit/` and wire level coverage in `tests/wire/`. Mock server utilities for wire tests live in `tests/mock-server/`.

## Build, Test, and Development Commands
1. `npm run build` compiles TypeScript to `dist/` using `tsc`.
2. `npm test` runs all Jest projects.
3. `npm run test:unit` runs the unit test project only.
4. `npm run test:wire` runs the wire test project with MSW based mocks.

## Coding Style and Naming Conventions
Use TypeScript with strict typing, avoid `any` unless there is no alternative. Indentation is two spaces, and semicolons are used. Use `camelCase` for variables and methods, `PascalCase` for classes and exported types. Follow existing filename patterns, `PascalCase` for class files and lowercase for small utilities. Keep public client options and request payloads in `camelCase`.

## Testing Guidelines
Tests use Jest with project separation for unit and wire suites. Test files follow the `*.test.ts` pattern, for example `tests/unit/client/Client.test.ts`. Prefer adding unit coverage for helper logic and wire tests for client request and response behavior. Run the smallest relevant suite while iterating, then run `npm test` before submitting changes.

## Commit and Pull Request Guidelines
Recent history shows short, descriptive subjects without strict prefixes, so keep commit messages concise and clear about the change. For pull requests, include a summary, the test commands you ran, and any API surface changes. If you add or change a public method, update `README.md` usage examples.

## SDK Documentation Sync
Whenever you change the SDK, update the website API documentation in `app/components/docs/` to match the new behavior. Before finishing any SDK update, use a sub agent to review and apply the documentation updates in `app/components/docs/`, and do not exit until that review is complete.
Before finishing any SDK update, use a sub agent to review `README.md`, apply any updates needed to match the code, and do not exit until that review is complete.

## Configuration Tips
Set `DIFFIO_API_KEY` for authentication and `DIFFIO_API_BASE_URL` to target emulators or alternate environments. Use Node 18 or later so the built in `fetch` API is available.
