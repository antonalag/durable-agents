# Contributing to durable-agents

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/antonalag/durable-agents.git
cd durable-agents
pnpm install
pnpm build
pnpm test
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Write tests for any new functionality
3. Ensure `pnpm build && pnpm test && pnpm lint` passes
4. Submit a PR with a clear description

## Code Style

- TypeScript strict mode
- ESM imports with `.js` extensions
- No decorative comments (see the project's code style guidelines)
- Property-based tests with fast-check for algorithmic code

## Commit Format

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`
