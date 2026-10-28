# Contributing

This repository is a read-only mirror of the boxd Python SDK. Development happens
in the boxd monorepo, and a job copies every change here. The package
(`boxd` on PyPI) is published from the monorepo, not from this repository.

## Issues

Issues are welcome: bug reports, missing features, unclear docs. Include the
SDK version, your runtime version and the smallest code that shows the problem.

## Pull requests

You can open a pull request, but it is not merged here. If we accept the
change, a team member applies it in the monorepo, and the mirror brings it
back to this repository. The mirrored commit carries the title of the
monorepo pull request and the name of the team member who merged it.

## Running the tests

```bash
uv sync --extra dev
uv run pytest
```

## Regenerating the protobuf stubs

The stubs under `src/` are generated from `proto/api.proto` and checked in.
Do not edit them by hand. To regenerate:

```bash
uv sync --extra dev
bash scripts/compile_proto.sh
```
