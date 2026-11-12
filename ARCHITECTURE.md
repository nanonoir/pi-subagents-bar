# Architecture

The repository is currently package scaffolding. `package.json` declares a Pi package and points Pi's extension loader at `src/index.ts`; that entry point is not present. The `src/` and `tests/` directories are empty in the current working tree and are not tracked by Git.

No implemented modules, runtime data flows, persistence, integrations, or architectural boundaries are available to describe yet. The package description identifies live subagent monitoring as its purpose, but does not specify its behavior or design.
