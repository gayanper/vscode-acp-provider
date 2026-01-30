# AGENTS.md

## Setup commands

- Install deps: `bun install`
- Compile: `bun run compile`

## Update Tests

- When user requests new test scenarios, update `src/testScenarios.ts` with the new scenarios as prompted by the user.

## New Features

- When adding new features, always make sure solutions are feasible based on vscode extension capabilities and proposed APIs.
- When formulating solutions read through the files at <https://github.com/microsoft/vscode/tree/main/src/vscode-dts> to ensure proposed solutions are implementable.
- Always take inspiration from existing popular extensions such as <https://github.com/microsoft/vscode-copilot-chat.git> by reading through their source code to understand how they implement similar features.

## Specifications

- ACP (Agent Client Protocol) : <https://agentclientprotocol.com/protocol/schema>
- VSCode Extension API: <https://code.visualstudio.com/api/references/vscode-api>
