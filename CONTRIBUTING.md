# Contributing

This repository is a read-only mirror of the boxd SDKs. Development happens in
the boxd monorepo, and a job copies every change here. The packages (`boxd` on
PyPI and `@boxd-sh/sdk` on npm) are published from the monorepo, not from this
repository.

## Issues

Issues are welcome: bug reports, missing features, unclear docs. Say which SDK
it is about, and include the SDK version, your runtime version and the
smallest code that shows the problem.

## Pull requests

You can open a pull request, but it is not merged here. If we accept the
change, a team member applies it in the monorepo, and the mirror brings it
back to this repository. The mirrored commit carries the title of the
monorepo pull request and the name of the team member who merged it.

A change to the API surface usually belongs in both SDKs: they share one
version and are released together.

## Running the tests

Python:

```bash
cd python
uv sync --extra dev
uv run pytest
```

TypeScript:

```bash
cd typescript
bun install
bun run typecheck
bun test tests/
```

## Regenerating the protobuf stubs

The stubs are generated from `proto/api.proto` and checked in. Do not edit
them by hand. To regenerate both:

```bash
(cd python && uv sync --extra dev && bash scripts/compile_proto.sh)
(cd typescript && bun install && bash scripts/compile_proto.sh)
```
