# TS SDK playground

Scratch space for driving the SDK by hand. Imports `../src` directly, so edits
to the SDK show up immediately — no build, no publish, no `npm link`.

Nothing in here is part of the published package (`files` in `package.json`
ships `dist/` only) and nothing here is run by CI.

## Setup

```bash
cd sdk/typescript
bun install                  # once
export BOXD_API_KEY=bxd_...  # from `boxd auth keys create`
```

Production is the default. To point somewhere else:

```bash
export BOXD_BASE_URL=https://boxd.example.com:9443  # another cluster
export BOXD_BASE_URL=https://boxd.sh:9443   # metal
```

The API-key exchange host is derived from that one URL — there is nothing else
to set.

## Run

```bash
bun run playground/scratch.ts      # start here — edit freely
bun run playground/tour.ts         # read-only: whoami, list machines/snapshots/disks/env
bun run playground/lifecycle.ts    # CREATES A REAL MACHINE, then destroys it
bun run playground/exec.ts         # exec, streaming exec, file upload/download
```

`tour.ts` only reads. `lifecycle.ts` and `exec.ts` create a real machine on a
real cluster and bill a real org — they print what they are about to do and wait
for confirmation. Pass `--yes` to skip the prompt.

## Notes

- `Ctrl-C` is safe: each script destroys what it created in a `finally`.
- Machines are named `pg-<random>` so they are easy to spot and sweep.
- If you get `AuthenticationError`, the key is wrong or revoked — it is not
  retried on purpose, since a revoked key would otherwise spin forever.

## Using the SDK from another project

Straight-from-git does **not** work, for three reasons: the package sits in a
subdirectory of a monorepo (bun and npm git deps can't select one), the repo is
private, and `dist/` is gitignored — so a git checkout has no built output for
`main` to point at. Use one of these instead.

**Same machine — a local path dependency:**

```bash
cd sdk/typescript && bun run build     # dist/ is gitignored; build it first
cd ~/your-project && bun add /home/boxd/boxd-2/sdk/typescript
```

**Same machine, picking up SDK edits live:**

```bash
cd sdk/typescript && bun link
cd ~/your-project && bun link @boxd-sh/sdk
```

Still re-run `bun run build` after changing the SDK — consumers resolve `dist/`,
not `src/`. (The scripts in this directory import `../src` precisely to skip that.)

**Another machine — a tarball:**

```bash
cd sdk/typescript && bun run build && bun pm pack   # → boxd-sh-sdk-<version>.tgz
# copy it over, then:
bun add ./boxd-sh-sdk-0.1.9.tgz
```

**Anyone, anywhere — publish a prerelease.** `Actions → Publish SDKs → Run
workflow`, environment `staging`: it publishes `<version>-dev.<run>` under the
`next` dist-tag, so `bun add @boxd-sh/sdk@next`. See `sdk/CLAUDE.md` — note step 2
of that flow (telling the proxy what "latest" is) runs from a laptop, not CI.
