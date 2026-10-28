# @boxd-sh/sdk

TypeScript SDK for the [boxd](https://boxd.sh) cloud machine platform.

Promise-only, ESM-only. Runs on Node 20+, Bun, and Deno.

## Install

```bash
npm install @boxd-sh/sdk
# or: bun add @boxd-sh/sdk
```

## Quick start

```typescript
import { Boxd } from "@boxd-sh/sdk";

const boxd = new Boxd({ apiKey: "bxd_..." });

const machine = await boxd.machines.create({ name: "my-machine" });
await boxd.machines.waitUntilReady(machine.id);

const result = await boxd.machines.exec(machine.id, { command: ["echo", "hello"] });
console.log(result.stdout);

// What it cost (metered every few minutes; still answers after delete):
const usage = await boxd.machines.usage(machine.id);
console.log(usage.costMicro / 1e6, usage.currency);

await boxd.machines.delete(machine.id);
await boxd.close();
```

The client is the only stateful object. Everything else is a namespace of flat
methods that return plain data — a `Machine` is a record of fields, not a
handle, and every operation takes the machine id as its first argument.

## Client construction

```typescript
new Boxd();                                        // production
new Boxd({ apiKey: "bxd_..." });
new Boxd({ baseURL: "https://boxd.example.com" }); // any other cluster
```

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `BOXD_API_KEY` | — |
| `token` | `BOXD_TOKEN` | — |
| `baseURL` | `BOXD_BASE_URL` (or the deprecated `BOXD_API_URL`) | `https://boxd.sh:9443` |
| `timeout` | — | 60000 ms |
| `maxRetries` | — | 2 |

`baseURL` accepts an optional scheme that controls TLS:

| Value | Transport |
|---|---|
| `http://host:port` | plaintext |
| `https://host:port` | TLS |
| bare `host:port` | TLS, except `localhost` / `127.*` |

Failed connections are retried up to `maxRetries` times with exponential
backoff. Timeouts are never retried — the request may already have been
applied — and authentication failures are never retried either.

## Cloudflare Workers and other non-Node runtimes

The default `@boxd-sh/sdk` entry point uses gRPC (`@grpc/grpc-js`), which needs
Node's `http2`/`net` modules and does not load in a Cloudflare Worker or a
browser. Import from `@boxd-sh/sdk/web` instead — same client, same
namespaces, same options, same errors:

```typescript
import { Boxd } from "@boxd-sh/sdk/web";

const boxd = new Boxd({ apiKey: "bxd_..." });
const machine = await boxd.machines.create({ name: "my-machine" });
```

This entry talks to the same `:9443` endpoint over grpc-web (`fetch`) —
every call, including `exec()` and large (`files.upload` over 4 MiB)
uploads, goes over one wire protocol `fetch` can carry. Nothing about your
code changes; only the import path does. It works anywhere `fetch` is
available (Workers, browsers, Bun, Deno, Node 20+) — use the default entry
on a server unless you have a specific reason not to.

Three things need the default entry, and fail on this one with an error that
says so:

- `streamExec()` (interactive PTY sessions): it needs a connection that's live
  in both directions at once, which grpc-web can't provide.
- `files.upload(..., { fromPath })`: this entry doesn't read local files. Pass
  the contents as a string or `Uint8Array`.
- Automatic authentication inside a boxd machine: pass an `apiKey` or `token`,
  or set `BOXD_API_KEY` / `BOXD_TOKEN`.

Ordinary `exec()` and file uploads are unaffected: both already send
everything and then read the result, on either entry. The same goes for
`fs.write()`, which on this entry collects a stream source in memory before
sending it.

## Authentication

```typescript
new Boxd({ apiKey: "bxd_..." });   // recommended
new Boxd({ token: "..." });        // a token you already hold
new Boxd();                        // BOXD_API_KEY, then BOXD_TOKEN
```

Credentials are resolved in this order, first match wins:

1. an explicit `token`
2. an explicit `apiKey`
3. `BOXD_TOKEN`
4. `BOXD_API_KEY`
5. automatic, inside a boxd machine (below)

If none of those produce a credential, the first request throws
`AuthenticationError` with `reason: "missing_credentials"`.

An API key is exchanged for a short-lived session token and kept fresh for you.
Revoking a key takes effect immediately, so if a key is revoked mid-run the next
call fails with `AuthenticationError` rather than retrying. Only a refusal is an
`AuthenticationError`: a key whose account may not use the API (a disabled
account) is a `PermissionDeniedError`, an exchange that can't be reached is an
`APIConnectionError` (retried), and one that answers with an error or an
unreadable body is an `APIStatusError` carrying the `httpStatus`.

The exchange endpoint is **rate-limited per source IP** (30 requests / 60s). The
session token is valid for one hour, so a fleet of workers behind one NAT should
**mint one token and share it** (`new Boxd({ token })`) rather than each process
exchanging its own key. On a 429 the client waits out one `Retry-After` before
throwing `RateLimitError`.

### Inside a boxd machine

Running inside a boxd machine, `new Boxd()` from the default entry
authenticates automatically — no API key, no configuration:

```typescript
const boxd = new Boxd();
const mine = await boxd.machines.list();
```

The client also points itself at the cluster the surrounding machine belongs
to, so the same code runs unchanged wherever it is deployed. Passing an explicit
`baseURL` or credential still wins.

An *isolated* machine has no automatic credentials: pass an `apiKey` or `token`,
or set `BOXD_API_KEY` / `BOXD_TOKEN`. If the machine's metadata adapter doesn't
answer, the call throws `AuthenticationError` with `reason:
"missing_credentials"` naming the adapter, and the next call asks again.

**Limits inside a shared machine.** Automatic credentials act within the
organization that owns the machine. From a *shared* machine you can manage the
organization's shared machines, but you cannot read env vars or secrets, and you
cannot reach machines that are private to another member. Use an API key for
those.

## Machines

```typescript
const machine = await boxd.machines.create({ name: "my-machine" });
const one     = await boxd.machines.get(machine.id);   // id or name
const all     = await boxd.machines.list();            // Machine[]
await boxd.machines.list({ org: "acme" });             // one organization's machines
await boxd.machines.list({ allContexts: true });       // every org you belong to
await boxd.machines.delete(machine.id);

await boxd.machines.start(id);
await boxd.machines.stop(id);
await boxd.machines.reboot(id);
await boxd.machines.pause(id);        // suspend to RAM → { suspendUs: number }
await boxd.machines.resume(id);       // { resumeUs: number }
await boxd.machines.hibernate(id);    // suspend to disk
await boxd.machines.wake(id);

const fork = await boxd.machines.fork(id, { name: "fork-1" });
await boxd.machines.fork(id, { shared: true }); // forks keep the source machine's size
await boxd.machines.share(id);        // visible to the whole org
await boxd.machines.unshare(id);

const renamed = await boxd.machines.rename(id, "new-name");   // the new name; reboots
await boxd.machines.setAutoSuspendTimeout(id, 300);    // seconds; 0 disables
await boxd.machines.setAutoHibernateTimeout(id, 3600);
await boxd.machines.setIdleIgnoreOutbound(id, true);   // only inbound connections keep it awake
await boxd.machines.setSsh(id, false);                 // nothing answers SSH; exec still works

await boxd.machines.waitUntilReady(id);       // running *and* exec works
await boxd.machines.waitUntilReady(id, { timeout: 180_000, pollInterval: 1_000 }); // ms
const suggested = await boxd.machines.suggestName();
```

`list()` returns a plain array. A fork inherits the source's sizing for anything
`config` leaves unset, and is private to you unless you pass `shared: true`.

With SSH off (`config: { ssh: false }` on create, or `setSsh(id, false)`),
nothing answers SSH on the machine's port, on the public address or the org's
network, and SSH sessions already open to it are closed. The port stays
allocated, so turning SSH back on keeps the address. `exec`, `boxd connect` and
the console terminal don't use SSH and keep working. A fork or a restore keeps
its source's setting unless `config.ssh` says otherwise. `setSsh` can't be
called from inside the machine itself.

### Creating

```typescript
await boxd.machines.create({
  name: "builder",
  image: "ubuntu:24.04",
  env: { API_URL: "https://example.com" },
  cmd: ["/usr/local/bin/start"],
  restartPolicy: "always",           // "always" | "never"
  config: {
    vcpu: 2,
    memory: "8G",                    // sizes: 1 vCPU/4G, 2/8G, 4/16G, 8/32G
    disk: "100G",
    autoSuspendTimeout: 300,         // seconds; 0 disables
    autoDestroyTimeout: 0,
    ssh: true,                       // false: SSH off, nothing answers on its port
    proxies: [{ name: "api", port: 3000 }],   // `port` optional — detected if omitted
    volumes: [{ diskId: "d_...", mountPath: "/data", readOnly: false }],
  },
});

// Every option is optional — this boots the cluster's default image.
await boxd.machines.create();

// In an organization. `shared` makes it visible to every member.
await boxd.machines.create({ org: "acme", shared: true });

// From a snapshot instead of an image.
await boxd.machines.create({ fromSnapshot: "golden", name: "from-golden" });
```

Restoring a snapshot replays the machine as it was captured, so `fromSnapshot`
goes with `name`, `org` and `config` — the options that describe a fresh
machine are a compile error beside it.

Renaming reboots the machine, so it is its own call. Every other setting is
readable straight off `Machine`.

### Machine specs

A machine spec describes a machine in one value: what it boots from, its size,
labels, networks, isolation, egress, env, the secrets it gets, the
integrations and agent logins it needs, and the packages it installs on first boot. Build one from reusable pieces and create from it:

```typescript
import { Machine, team, snapshot, github, slack, jira, claude, secrets } from "@boxd-sh/sdk";

const engineering = Machine.spec()
  .from(team("eng"))                     // a team's default snapshot; or snapshot("eng-base")
  .network("eng")
  .label("team", "eng")
  .env("NODE_ENV", "development")
  .packages("apt-get update", "apt-get install -y nginx")
  .with(github({ shared: "eng-bot" }), claude());

const mike = engineering
  .size("2x8")
  .with(slack(), jira({ shared: "jira" }), secrets("NPM_TOKEN"));
const m = await boxd.machines.create({ name: "mike-dev", org: "acme", spec: mike });
m.spec;          // the spec as it stands (updateSpec, and label, network, egress and size edits, update it)
m.createdSpec;   // the spec it was created with, never changed
mike.resolve();  // the same spec as plain data, without creating anything
```

| Builder | Sets |
|---|---|
| `.from(team(name))` / `.from(snapshot(name))` | `base`. Omit for the default image. |
| `.size("1x4" \| "2x8" \| "4x16" \| …)` | `size`, `<vcpu>x<memory GiB>` |
| `.assignTo(userId)` | `assignTo`: create the machine for another member of the org (below) |
| `.label(key, value)` / `.label({ … })` | `labels` |
| `.network(...names)` | `networks` |
| `.isolated()` | `isolated` |
| `.egress(...hosts)` | `egress`: the machine's egress allowlist from birth |
| `.env(key, value)` / `.env({ … })` | `env`: wins over org and personal vars of the same name |
| `.packages(...commands)` | `packages`: shell commands run once after the first boot (below) |
| `.with(...pieces)` | merges pieces or other builders |

Pieces: `slack()`, `jira()`, `github()`, `asana()` (pass `{ shared: "tag" }` to
use the org connection shared under that tag instead of the owner's own),
`claude()`, `codex()`, and `secrets(...names)` (below). Integrations and agent logins are recorded on the
machine; a missing one never blocks the create (see "Integrations the machine
needs"). A piece is a plain object (`{ labels: { … } }`, or
`{ connections: { notion: "personal" } }` for any toolkit), so you can write your own.

Pieces merge in order: maps (`labels`, `env`, `connections`) merge with the
later piece winning, lists (`networks`, `egress`, `secrets`, `agents`,
`packages`) combine in order without duplicates, `isolated` only turns on, and `base`, `size` or `assignTo`
set twice to different values throws. So does a key a spec doesn't have, and a
name in both `env` and `secrets`. The server checks
every field and names it in its error (`spec.size: ...`).

A spec carries its machine's base, size, labels, networks, isolation and env,
so `create({ spec })` takes none of `image`, `env`, `labels`, `networks`,
`isolated` or `config` sizing beside it. A spec whose base is a snapshot (or a
team with a default snapshot) restores it. A snapshot keeps its machine's spec:
restoring it gives the new machine that spec, and
`create({ fromSnapshot, spec })` merges a spec on top by the same rules; its
`size`, if set, must be the snapshot's. A fork keeps its source's spec.

#### Secrets

A spec names the secrets its machine gets; their values stay in
`boxd.secrets`. Usually they are `unattached` secrets, which reach no machine
until a spec lists them:

```typescript
await boxd.secrets.set("NPM_TOKEN", "npm_…", { scope: "unattached", org: "acme" });

const m = await boxd.machines.create({
  name: "mike-dev",
  org: "acme",
  spec: engineering.with(secrets("NPM_TOKEN")),
});
```

A name resolves, on your own machine, to your own secret first
(`private-unattached`, then `private`), else the org's (`unattached`, `all`,
`shared`). On a machine created for someone else, or a shared machine, only
the org's secrets count. Only org owners and admins may list an org
`unattached` secret in a spec, and an org `shared` secret only reaches
shared machines, so a private machine can't list one. A name that resolves to
nothing, or that the create may not list, fails the create, naming it.

Only org owners and admins may set, move or delete an org `unattached` secret;
your own (`private-unattached`) are yours. From inside a machine (with its
in-VM credentials) a spec can't list an unattached secret, yours or the org's,
on any machine, and `updateSpec` can't change that machine's own `egress` or
`secrets`; make those changes from outside the machine, with an API key or in
the console. Names a fork or a restore takes over from its source's spec are
not affected.

On the machine, the spec's `env` and its `secrets` win over your `private`
vars, which win over the org's `shared` vars (shared machines only), which win
over the org's `all` vars. A name can't be in both `env` and `secrets`.

The machine keeps a reference, not a copy: rotating the secret reaches it, and
deleting the secret takes it away
(setting it again with the same name brings it back). Forks, snapshots and
restores resolve the
names again, and fail naming any that no longer resolve. A secret's
`boundMachines` says how many machines list it.

#### Creating a machine for someone else

An org owner or admin can create a machine for another member of the org with
`.assignTo(userId)` (the member's user id, as `orgs.getMembers()` lists it):

```typescript
const m = await boxd.machines.create({
  name: "mike-dev",
  org: "acme",                          // required: the org the machine is for
  spec: engineering.size("2x8").assignTo("usr_e393f70e…"),
});
```

The machine is the member's from the start: private to them, billed to the
org, and set up with their own integrations and agent logins. You can't see or
reach it afterwards, so `create()` answers with its id and name only, and the
create can't also set `deleteAfter`. The member sees `createdBy` (your user id)
and `createdByName` on it. Refused, naming `spec.assignTo`: without `org`, with
`shared: true`, for a caller who isn't an owner or admin of the org, with an
org API key or from inside a machine, for someone who isn't a member, and with
a snapshot or disk the member couldn't use. Your own id is a plain create.
`assignTo` is never inherited: forks, snapshots and restores drop it.

The machine runs the spec you wrote as the member's own machine: its packages
as root, its env and its base, alongside the member's GitHub token, agent
logins and personal connections. Assign a spec only if the member would run it
themselves. The member sees who created it (`createdBy`) and can read the
spec (`machine.spec`).

#### Integrations the machine needs

A spec's `connections` and `agents` are the machine's requirements. Reading the
machine (`get`, `list`, the machine `create` returns) tells you, for each one,
whether it is connected right now:

```typescript
const m = await boxd.machines.get("mike-dev");
for (const r of m.requirements) {
  // { kind: "connection", name: "jira", scope: "shared", tag: "jira", met: false, canFix: true, reason: null }
  console.log(r.name, r.scope, r.tag, r.met ? "connected" : r.canFix ? "connect it" : r.reason ?? "ask an org admin");
}
```

A `personal` connection is the machine owner's own connection for that toolkit
in the machine's org (on a machine created with `assignTo`, the member's), a
`shared` one the org's connection shared under `tag`, and an agent the owner's
Claude Code or Codex sign-in. `canFix` says whether you could connect it: the
owner for personal ones and agents, an org owner or admin for shared ones.
Connect from the console: the machine's page lists them with a Connect button.

An unmet requirement is only unavailable on the machine; nothing blocks
creating, booting or using it. Some can't be met on the machine as it is, and
`reason` says why: an isolated machine gets no integrations or agent logins,
and a shared machine never gets anyone's personal connection or agent login
(require `shared:<tag>` instead). The create refuses a toolkit this cluster
can't connect (`spec.connections.<toolkit>: ...`), and the GitHub App
(`github-app`) only as `"shared:org"`.

#### Packages

`packages` are shell commands the machine runs once, in order, after its first
boot: as root, with bash (sh on an image without it),
`DEBIAN_FRONTEND=noninteractive`, no stdin, the env and secrets an exec
session on the machine gets, and a 30-minute timeout each. Their output is
appended to `/var/log/boxd/packages.log` in the machine, which only root can
read. A command is done when its shell exits, so one that leaves a process
running in the background (`my-server &`) doesn't hold up the next. The first
failure (a non-zero exit, a timeout) stops the rest; the machine stays usable,
and `updateSpec(id, {}, { retryPackages: true })` runs the failed command and the ones after it again (so does
Retry in the console's Packages section). To give up on a command instead, or
to replace a wrong one, remove it from the spec: a command that leaves the spec
before it finished is skipped, and the ones after it run. Reading the machine
tells you how each one went:

```typescript
const m = await boxd.machines.get("mike-dev");
for (const p of m.packages) {
  // { command: "apt-get install -y nginx", state: "failed", exitCode: 100, outputTail: "E: Unable to locate…", reason: null, … }
  console.log(p.state, p.exitCode, p.command);
}
```

`state` is `"pending"`, `"running"`, `"done"`, `"failed"` or `"skipped"`; the
commands after a failure stay `"pending"`. A pending or failed command that an
`updateSpec` removes from the spec becomes `"skipped"`: it never runs and no
longer stops the ones after it, which run right away (or when the machine next
runs). A skipped one that failed keeps its `exitCode` and `outputTail`, and
`reason` says when it was skipped. Listing it in the spec again puts it back to
`"pending"`, in its place. So replacing a broken command is one patch: drop it
and add the corrected one, and the corrected one runs, with everything that
was waiting. A running command can't be removed (the patch is refused until it
ends), and removing a done one undoes nothing. `outputTail` is the last 4 KiB of the
command's output, with the value of every secret the machine gets shown as
`[secret NAME]` (only the value as it is: printed encoded or in pieces, it isn't
recognised). The log file isn't masked: it is root's, and root on the machine
can read its env anyway. `outputTail` is empty on the machines `list()` returns,
which leave it out to keep the list small; `get()` has it. `reason` says why a failed one has no exit code (it
timed out, or was interrupted too often), or why a pending one is waiting. A
command the platform interrupts (the machine stops, reboots, hibernates or
moves, or boxd restarts on the machine's host) goes back to `"pending"` and runs
again from the start once the machine is running, and the rest follow; after 3
interruptions it fails. What finished never runs again: not on a reboot, a
resume, a wake or a move. Restoring a snapshot marks done the commands that had
run on the machine the snapshot was taken from and runs the snapshot spec's
others (one that was running when the snapshot was taken runs again from the
start), then the ones the restore's spec adds; a fork keeps its source's states
and runs nothing. The machine doesn't auto-suspend or
hibernate while a command runs. At most 50 commands (a restore counts the
snapshot's too), each at most 4 KiB; the server names the one it refuses
(`spec.packages[2]: ...`). Commands that download something need the hosts in
the spec's `egress`, if it has one.

A spec has size limits, checked before anything else and named with what was
given (`spec.env: at most 128 variables (got 129)`): at most 256 KiB as JSON
in all; `env` at most 128 variables, each value at most 32 KiB and all values
together at most 64 KiB; `secrets` at most 64 names; `networks` at most 16, each
name at most 63 bytes; `egress` at most 256 entries, none empty (leave `egress`
out for no allowlist); `connections` at most 64; `packages` at most 200 listed
and 50 once duplicates are dropped. An `updateSpec` patch is at most 256 KiB.

#### Updating a machine's spec

`updateSpec` changes the spec of a machine created from one and applies what
changes. Pass a JSON Merge Patch, or a function that adds to the current spec:

```typescript
// Patch: a field left out is untouched, a scalar replaces, maps merge key by
// key (null removes a key), a list replaces the whole list, null removes a field.
await boxd.machines.updateSpec("mike-dev", {
  labels: { owner: "mike", team: null },
  networks: ["eng", "ops"],
  packages: ["apt-get install -y nginx", "npm i -g pnpm"],
});

// Builder: reads the spec, adds with the composition rules, sends the difference.
await boxd.machines.updateSpec("mike-dev", (s) => s.network("ops").env("LOG_LEVEL", "debug"));

// Dry run: the diff, nothing changed.
const diff = await boxd.machines.updateSpec("mike-dev", { size: "4x16" }, { dryRun: true });
for (const c of diff.changes) console.log(c.field, c.apply, c.note, c.warnings);
if (diff.rebootRequired) {
  await boxd.machines.updateSpec("mike-dev", { size: "4x16" }, { reboot: true });
}
```

Each change in `changes` says how it applies (`apply`):

| Field | `apply` |
|---|---|
| `labels`, `networks`, `egress` | `"live"` (new egress rules are in force within about a second of the call returning) |
| `connections`, `agents` | `"live"`: what the machine needs (`requirements`) changes |
| `packages` | `"live"`: added commands run now, after the ones before them. Removing one undoes nothing (a warning says so); a pending or failed one the patch removes is skipped (listed in `skipped`), so the ones after it run, and a skipped one listed again goes back to pending in its place (`unskipped`); a command that already ran isn't run again; commands after a failed one don't run (a warning says so) unless the update also retries (`retryPackages`: the failed command and the rest run again first, listed in `changed`, skipped ones excepted; a failed command the patch removes is skipped, not retried). Removing a running command is `"refused"` until it ends |
| `env`, `secrets` | `"reboot_recommended"`: new shells and exec sessions get them now; processes already running keep the old values until they restart (`rebootRecommended`) |
| `size` | `"reboot"` on a running machine, which reboots to apply it (as `resize`), so it needs `{ reboot: true }`; `"live"` on a stopped one |
| `base`, `isolated`, `assignTo` | `"refused"`: fixed when the machine is created |

A refused change (also: new packages or a retry on a fork, a size change in standby or
hibernated) refuses the whole patch, and so does a reboot without
`{ reboot: true }`; nothing is applied. So is an update during which the
spec changed (another update, a label edit): it throws `ConflictError`, and
reading the machine again and retrying is safe. The builder form does that
itself: it sends the spec it read, so a change made in between can't be
undone by its lists, and on a conflict reads the spec again and reapplies the
function, up to 3 times. A patch you built from a spec you read can say so
too, `{ expectedSpec: machine.spec }`: if the spec is no longer that one,
nothing is applied and it throws `ConflictError`. Otherwise the spec and the labels,
networks, egress and secrets it drives change together, then the size, then
the new packages run. If the size then fails (the org's quota changed, the
machine went to standby), the rest stays applied and the call still returns:
`resizeError` says why, and `spec` has the size the machine has. The patched spec is checked like a create's (an
unknown toolkit, a secret you may not list, more than 50 commands in all are
refused, naming the field). `machine.createdSpec` never changes, so the
console shows the spec badge as "updated". Allowed to whoever may edit the
machine's labels: its owner, or an org owner or admin on a shared machine.
The builder form only adds: a `size` that differs from the spec's throws
(`"2X8"` is the same as `"2x8"`), so
use a patch to replace or remove. `specPatch(from, to)` computes the patch the
builder form sends.

### Egress allowlist

A machine can be limited to what it may reach on the internet:

```typescript
await boxd.machines.setEgressAllow("alpha", ["api.stripe.com", "*.github.com", "203.0.113.0/24"]);
(await boxd.machines.get("alpha")).egressAllow;
await boxd.machines.setEgressAllow("alpha", ["none"]);   // nothing is reachable
await boxd.machines.setEgressAllow("alpha", []);   // clear: unrestricted again
```

Entries are hostnames or wildcards, or public IPv4 addresses and CIDRs, at
most 256; an internationalized name is kept in its ASCII form (`bücher.de`
becomes `xn--bcher-kva.de`), which is what the machine looks up. Web
requests are admitted by hostname, everything else by address, with the
addresses of allowlisted names learned as the machine resolves them. Nothing
that is not named is reachable. The hosts of any bound secret the machine
holds are always admitted. `"none"` on its own leaves the allowlist on with
nothing in it, so the machine reaches only those; next to other entries it is
dropped. Takes effect within a second. From inside the
machine it can be read (`boxd machine egress`) but not changed. A fork inherits its source's allowlist; a
machine restored from a snapshot starts unrestricted, unless its machine spec
lists `egress`.

### Labels

Labels are `key=value` tags for grouping and finding machines:

```typescript
const m = await boxd.machines.create({ name: "job-1", labels: { env: "prod", run: "nightly" } });
m.labels;                                                     // { env: "prod", run: "nightly" }
await boxd.machines.list({ labels: { run: "nightly" } });     // every pair must match
await boxd.machines.list({ labels: ["env=prod", "gpu"] });    // "key=value", or "key" = has the key
await boxd.machines.updateLabels("job-1", { set: { owner: "ana" }, remove: ["run"] });
await boxd.machines.updateLabels("job-1", { set: { env: "dev" }, replaceAll: true }); // set the whole set
```

Keys are 1-63 characters of lowercase letters, digits, `.`, `_`, `/` and `-`,
starting and ending with a letter or digit; the `boxd/` prefix is reserved.
Values are up to 256 characters and may be empty. A machine holds at most 64
labels. A fork or restore inherits its source's labels, and `labels` on
`fork` or `create({ fromSnapshot })` is merged over them.

### Sizing

There are four sizes: 1 vCPU/4G, 2/8G, 4/16G, 8/32G. Name either dimension and
the other follows, so `{ vcpu: 2 }` and `{ memory: "8G" }` are the same
request. Anything above your org's quota is refused, never quietly clamped.

A machine keeps the size it was created with, through stop/start, wake, and
migration alike. Changing it is an explicit call:

```typescript
const result = await boxd.machines.resize(id, { memory: "8G" });   // or { vcpu: 2 }
result.vcpu, result.memoryBytes;   // the size now persisted
result.rebooted;                   // it was running, so it was rebooted
```

A **running** machine is rebooted to apply the new size: a cold boot, so the
disk survives and anything in RAM does not. A **stopped** machine takes it at
its next start. A suspended or hibernated machine is refused, because its
saved memory image is the old size — resume or wake it first.

A create that names no size uses the org default (see
[Organizations](#organizations)), and a fork always inherits its source's size.

### The `Machine` record

```typescript
interface Machine {
  id: string;
  name: string;
  status: MachineStatus;   // "pending" | "starting" | "running" | "suspended" |
                           // "hibernated" | "stopped" | "failed" | "destroyed" | "migrating"
  imageRef: string;
  restartPolicy: string | null;
  createdAt: Date | null;          // null when no creation time is on record

  resources: {                     // what the machine actually got, not what
    vcpu: number;                  // you asked for — always concrete
    memoryBytes: number;
    diskBytes: number;
  };

  org: { id: string; name: string } | null;   // null = your personal quota
  shared: boolean;                 // shared with that org, or private to you

  access: {
    sshPort: number | null;        // null until allocated
    domain: string;
    url: string;                   // `https://<name>.<domain>`
  };
  ssh: boolean;                    // false: SSH is off, nothing answers on sshPort

  idle: {                          // seconds; 0 = that timer is disabled
    suspendAfter: number;
    hibernateAfter: number;
    destroyAfter: number;
  };

  source: MachineSource | null;    // null = booted from an image
  hibernatedAt: Date | null;       // null = not hibernated
  lastConnectedAt: Date | null;    // null = never connected
  bootTimeMs: number | null;       // last boot duration; null = never booted
  spec: MachineSpec | null;        // the machine spec it runs under; null = none
  createdSpec: MachineSpec | null; // the spec it was created with
  createdBy: string | null;        // who created it for you (spec `assignTo`); null = you did
  createdByName: string | null;    // a name to show for createdBy
  requirements: MachineRequirement[]; // the spec's connections and agents, and whether each is met
  packages: MachinePackage[];      // the spec's packages and how each went
}

interface MachineRequirement {
  kind: "connection" | "agent";
  name: string;                    // toolkit ("slack", "github-app") or agent ("claude", "codex")
  scope: "personal" | "shared";
  tag: string | null;              // the shared connection's name
  met: boolean;                    // connected now
  canFix: boolean;                 // you could connect it
  reason: string | null;           // why this machine can't get it (isolated, shared, ...)
}

interface MachinePackage {
  command: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  exitCode: number | null;         // null until it exits, and for a timeout or an interrupted run
  outputTail: string;              // the last 4 KiB of its output; empty from list(), get() has it
  reason: string | null;           // why there is no exit code, why it was skipped, or that a restored snapshot ran it
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface MachineSource {
  kind: "fork" | "snapshot";
  name: string;                    // source machine, or snapshot name
  version: number | null;          // snapshots only; a fork has no version
  id: string | null;               // provenance — may not resolve
}
```

`null` always means "not set": a port that was never allocated, a boot that
never happened, an org you do not have. Where `0` is a real answer — a disabled
idle timer — it stays `0`.

`org` is the org the machine belongs to and is billed to; `shared` says whether
your teammates can see it. A private machine can still be org-billed, so
`org` set with `shared: false` is normal, not a contradiction.

`source.id` points at the machine or snapshot this one came from. It is a record
of where the machine came from, not a live link — **it may not resolve**, and a
lookup that finds nothing is normal.

`MACHINE_STATUSES` is exported as an array of every status this release knows,
alongside `isKnownMachineStatus(s)` to check one:

```typescript
import { MACHINE_STATUSES, isKnownMachineStatus } from "@boxd-sh/sdk";
```

### Exec

One-shot exec collects the output:

```typescript
const r = await boxd.machines.exec(id, { command: ["python", "script.py"] });
r.stdout;    // string
r.stderr;    // string — populated for non-PTY execs
r.exitCode;  // number
r.success;   // boolean

await boxd.machines.exec(id, {
  command: ["sh", "-c", "echo $FOO"],
  env: { FOO: "bar" },
  timeout: 30_000,        // milliseconds
});
await boxd.machines.exec(id, { command: "make", cwd: "/srv/app" });

// Under a PTY, stderr merges into stdout and `stderr` comes back empty.
await boxd.machines.exec(id, { command: "top -b -n1", tty: true, cols: 120, rows: 40 });
```

`command` takes argv — shell-quoted for you — or a ready-made command line as a
string. `cwd` runs the command from that directory; a `cwd` that doesn't exist
fails fast instead of silently running in the default directory. `timeout`
gives up on the call; whatever it started inside the machine may well still be
running.

**`r.stdout`/`r.stderr` are UTF-8-decoded:** any byte sequence that isn't
valid UTF-8 is silently replaced with `U+FFFD`, changing the length with no
error thrown. Fine for text output; corrupts binary output. For binary or
byte-exact output, read from `streamExec` instead — it yields raw
`Uint8Array` chunks, never decoded:

```typescript
const chunks: Uint8Array[] = [];
for await (const chunk of boxd.machines.streamExec(id, { command: "cat file.bin" })) {
  chunks.push(chunk);
}
```

Interactive and PTY sessions use a stream handle, the one stateful object
besides the client:

```typescript
const stream = boxd.machines.streamExec(id, { command: "bash", tty: true });

stream.write("echo hello\n");
stream.end();          // half-close stdin — the process sees EOF
for await (const chunk of stream) process.stdout.write(chunk);
const code = await stream.wait();   // resolves with the exit code
stream.exitCode;       // number | undefined — set once the process is done
stream.close();        // cancel the session; safe to call twice
```

`streamExec` hands the stream back synchronously and buffers whatever you write
until the session is live. Iterating the stream yields stdout as `Uint8Array`
chunks.

Without `tty`, stderr arrives separately on `stream.stderr` — useful when a
tool's progress goes to stderr and its answer to stdout. With `tty`, the
terminal layer merges the two onto stdout, as terminals do.

For TUI apps, pass the initial geometry and forward resizes:

```typescript
const stream = boxd.machines.streamExec(id, {
  command: "vim",
  tty: true,
  cols: process.stdout.columns,
  rows: process.stdout.rows,
});
process.stdout.on("resize", () =>
  stream.resize(process.stdout.columns, process.stdout.rows),
);
```

Headless one-shots that read stdin (`jq`, `cat`) hang waiting for input. Pass
`closeStdin: true` to send EOF immediately. It is rejected together with `tty`,
where stdin must stay open.

### Logs

```typescript
for await (const chunk of boxd.machines.logs(id)) process.stdout.write(chunk);
for await (const chunk of boxd.machines.logs(id, { follow: true })) { /* ... */ }
```

### Filesystem

`machines.fs` reads and writes files inside a machine as its user, the same
files `exec` commands see. Every call wakes a sleeping machine first.

```typescript
const fs = boxd.machines.fs;

await fs.write(id, "/app/config.json", JSON.stringify(config));  // parents are created
await fs.write(id, "run.sh", script, { mode: 0o755 });           // relative to /home/boxd
await fs.write(id, "/data/big.bin", someAsyncIterableOfChunks);  // streamed as it's read
const bytes = await fs.read(id, "/app/output.json");             // Uint8Array
const head = await fs.read(id, "/var/log/app.log", { offset: 0, length: 4096 });
for await (const chunk of fs.readStream(id, "/data/big.bin")) { /* ... */ }

const entry = await fs.stat(id, "/app");    // FsEntry
entry.isDir; entry.isFile; entry.isSymlink; entry.size; entry.mode; entry.mtime;
await fs.exists(id, "/app/output.json");    // false for a dangling symlink
const entries = await fs.list(id, "/app");  // one level; fs.listIter() streams
await fs.mkdir(id, "/app/cache/a/b");       // missing parents too; existing is fine
await fs.rename(id, "/app/a", "/app/b");    // { overwrite: false } to refuse replacing
await fs.remove(id, "/app/old.txt");
await fs.remove(id, "/app/cache", { recursive: true });
await fs.realpath(id, "/app/current");      // symlinks, `.` and `..` resolved
await fs.realpathBytes(id, "/app/current"); // the same, as exact bytes
```

A write replaces the whole file. The new contents are written beside it and
renamed over it, so a failed write leaves the old file as it was; a file that
renaming would change (one with several hard links, owned by another user, or a
mount point) is overwritten in place instead, without that guarantee. A symlink
is written through to its target, and an existing file keeps its mode and owner
unless you pass `mode`.

Filenames are bytes on the machine. `FsEntry.name`/`path`/`symlinkTarget`
and `realpath` decode them as UTF-8; `nameBytes`/`pathBytes`/`symlinkTargetBytes`
and `realpathBytes` are exact, and every path argument also takes a
`Uint8Array`.

A failure inside the machine throws `FilesystemError`, whose `code` is the
errno name Node's own `fs` uses and `reason` the exact failure. The common ones
have a subclass of their own:

| Class | `reason` | `code` |
|---|---|---|
| `MachineFileNotFoundError` | `not_found` | `ENOENT` |
| `MachinePermissionError` | `permission_denied` | `EACCES` |
| `MachineFileExistsError` | `file_exists` | `EEXIST` |
| `MachineIsADirectoryError` | `is_a_directory` | `EISDIR` |
| `MachineNotADirectoryError` | `not_a_directory` | `ENOTDIR` |

```typescript
import { FilesystemError, MachineFileNotFoundError } from "@boxd-sh/sdk";

try {
  await fs.read(id, "/app/missing.txt");
} catch (e) {
  if (e instanceof MachineFileNotFoundError) { /* ... */ }
  // equivalently: e instanceof FilesystemError && e.code === "ENOENT"
}
```

A machine started before this API existed throws `AgentOutdatedError`;
rebooting the machine updates it.

### Files, ports, proxies, checkpoints

```typescript
// Files — both directions stream, so there is no size cap. `download` still
// returns the whole file as one `Uint8Array`, held in memory.
const written = await boxd.machines.files.upload(id, "/app/file.txt", "text content");
await boxd.machines.files.upload(id, "/app/file.bin", new Uint8Array([1, 2, 3]));
await boxd.machines.files.upload(id, "/app/app.py", { fromPath: "local.py" });
await boxd.machines.files.upload(id, "notes.txt", "relative to /home/boxd");
const bytes = await boxd.machines.files.download(id, "/app/output.json");  // Uint8Array
```

`upload` returns the number of bytes the machine confirmed it wrote. Paths are
either absolute (`/app/file.txt`) or relative to the VM user's home directory
(`/home/boxd`) — a bare filename like `"notes.txt"` resolves to
`/home/boxd/notes.txt`, same as `"./notes.txt"` or `"sub/notes.txt"` would.

```typescript
// Raw TCP/UDP forwards (max 3 per machine).
const fwd = await boxd.machines.ports.expose(id, 5432);                  // tcp by default
await boxd.machines.ports.expose(id, 5353, { protocol: "udp" });         // "tcp" | "udp" | "both"
fwd.dns; fwd.publicPort; fwd.machinePort; fwd.protocol;
fwd.machineId; fwd.machineName;
await boxd.machines.ports.list(id);        // one machine's forwards
await boxd.machines.ports.list();          // every forward you own
await boxd.machines.ports.unexpose(id, 5432);   // echoes back the forward it removed
```

Connect on `dns:publicPort`. Re-exposing a machine port keeps its public port
and just updates the protocol set; `"both"` shares one public port across TCP
and UDP.

```typescript
// HTTPS routes — an id or a name works, like everywhere else.
const route = await boxd.machines.proxies.create(machine.name, "api", 3000);
route.name; route.port;
const routes = await boxd.machines.proxies.list(machine.name);
routes[0].name;        // string | null — null on the machine's default route
routes[0].domain;      // the hostname this route answers on
routes[0].port;        // number — where traffic actually goes
routes[0].portMode;    // "locked" (you pinned it) | "auto" (detected for you)
routes[0].isDefault;
routes[0].machineId; routes[0].machineName;
await boxd.machines.proxies.setPort(machine.name, 3001, { name: "api" });
await boxd.machines.proxies.setPort(machine.name, "auto");   // default route, auto-detected
await boxd.machines.proxies.delete(machine.name, "api");
```

`create` answers as soon as the route is accepted, so it confirms the subdomain
and the port it was pointed at; `list()` reports the full domain and the
resolved port.

`portMode: "auto"` detection runs continuously for the whole life of the
machine, not just once at boot: whenever the app binds one of a curated list
of common ports (80, 443, 8080, 8000, 3000, 5000, 5173), that becomes a
candidate, and it's adopted once roughly 750ms have passed with no *different*
candidate port seen (an already-adopted port won't be replaced again more
than once every 5s). So a redeploy or restart that moves your app onto a new
port is picked up on its own within a few seconds — no action needed. If your
app doesn't listen on one of those ports, or you don't want to wait out the
detection window, call `setPort` with the port explicitly instead of `"auto"`.

```typescript
// Checkpoints — restore a machine in place.
const cp = await boxd.machines.checkpoints.create(id, "before-upgrade");
cp.id; cp.name; cp.status;
const saved = await boxd.machines.checkpoints.list(id);
saved[0].sizeBytes;
saved[0].createdAt;    // Date
saved[0].createdBy;    // string | null
saved[0].available;    // restorable right now — mirrors `status === "ready"`
await boxd.machines.checkpoints.restore(id, "before-upgrade");
await boxd.machines.checkpoints.delete(id, "before-upgrade");
```

The machine must be running to take a checkpoint. `status` is `"pending"` until
the artifact lands, then `"ready"` (or `"failed"`) — poll `status` for
`"ready"` to know when `restore` will succeed. `available` is a convenience
mirror of that same check (`false` for `"pending"`/`"failed"`, and also `false`
if the machine has since migrated off the checkpoint's worker even though it's
`"ready"`); it is never a separate readiness signal from `status`. Checkpoints
belong to their machine and go away with it.

## Env vars and secrets

Two namespaces with identical methods. The difference is what comes back: an
env var has a readable `value`, a secret does not — secret values are
write-only and never leave the server.

```typescript
await boxd.env.set("API_URL", "https://example.com", { scope: "all" });
await boxd.env.list();       // [{ name, scope, value }]
await boxd.env.list({ org: "acme" });
await boxd.env.delete("API_URL", { scope: "all" });

await boxd.secrets.set("STRIPE_KEY", "sk_live_...", { scope: "private" });
await boxd.secrets.list();   // [{ name, scope, domains, boundMachines }] — no values
await boxd.secrets.delete("STRIPE_KEY", { scope: "private" });
```

A secret can be bound to the hosts it may be sent to. The machine then only
ever holds a placeholder, and the real value is substituted into HTTPS
requests to those hosts on the way out:

```typescript
await boxd.secrets.set("STRIPE_KEY", "sk_live_...", { scope: "all", domains: ["api.stripe.com"] });
```

Inside the machine, `STRIPE_KEY` is an opaque `bxds_…` string. An HTTPS
request to `api.stripe.com` carrying it anywhere (the URL, a header, Basic auth
included, or the body) arrives at Stripe with the real key. It is replaced only
over HTTPS, and only when both the server name the connection was opened for
and the request's own `Host` are hosts the secret is bound to: over plain HTTP
and in a request to any other host it stays the useless placeholder. A body
over 16 MiB with a `Content-Length` is sent as written, placeholder included.
Responses on those connections carry the placeholder instead of the value:
wherever the real value (8 characters or more) appears in a response's headers
or body exactly as it was sent, it is replaced, so a server that echoes the
request doesn't hand the value to the machine. A value the server sends back
re-encoded (base64, URL- or JSON-escaped) isn't caught, and neither is one in
a body compressed with anything but gzip or deflate (the proxy asks for an
uncompressed response). Nothing to configure in the machine, and the
placeholder does not change when the value is rotated. `domains` is the full desired set:
setting the secret again without it makes it a plain secret. Wildcards such as
`*.stripe.com` are accepted; provider-wide ones such as `*.amazonaws.com` are
refused.

`scope` defaults to `"shared"` on `set` and `delete`; `list` takes `org` only
and reports every scope. Leaving `org` out addresses your own private vars;
with an API key minted in an organization, those live in that organization,
so `org` is only needed to reach the organization's `shared`/`all` vars.

`set`, `delete` and `move` each return the server's human-readable
confirmation of what it did.

Scope decides which machines a value reaches:

| Scope | Applies to |
|---|---|
| `private` | only your own machines in that organization |
| `shared` | the organization's shared machines |
| `all` | every machine in the organization |
| `unattached` | secrets only: just the machines whose spec lists it ([Secrets](#secrets)); the organization's with `org` (set, moved and deleted by its owners and admins only), else your own |
| `private-unattached` | secrets only: your own unattached secret in the organization named by `org` |

`list` reports the organization's unattached secrets as `unattached` and your
own as `private-unattached`, each with `boundMachines`, the number of machines
whose spec lists it (0 for every other scope). `unattached` is for secrets
only: a plain value a machine needs belongs in its spec's `env`.

`move` changes the scope. It needs `from` as well as `to`, because the same
name can exist in several scopes at once:

```typescript
await boxd.secrets.move("STRIPE_KEY", { from: "private", to: "all" });
```

It is a move between two places, not a field update, so calling it twice fails
the second time. Env vars and secrets share one name space per scope, so an
existing env var can block a secret moving into that scope, and vice versa.

Pass `{ org: "acme" }` to any of these to work in an organization instead of
your personal scope.

## Snapshots and disks

```typescript
const snap = await boxd.snapshots.create(id, "golden");
snap.id; snap.name; snap.version; snap.status;
await boxd.snapshots.get("golden");                 // by name or id
await boxd.snapshots.list();
await boxd.snapshots.delete("golden");
await boxd.snapshots.list({ org: "acme" });         // `org` works on get/list/delete too

const disk = await boxd.disks.create("data", "10G");   // bytes or a human string
disk.id; disk.name; disk.sizeBytes; disk.status;
await boxd.disks.attach(disk.id, id, "/mnt/data");
await boxd.disks.attach(disk.id, id, "/mnt/data", { readOnly: true });
await boxd.disks.detach(disk.id, id);
await boxd.disks.list();
await boxd.disks.delete(disk.id);
```

The machine must be running to snapshot it, and `create` answers before the
artifact lands — `status` is `"pending"` until it does. Snapshots stay inside
one organization.

A disk is always created writable; read-only is chosen per attachment. A disk
can be attached to only one machine at a time.

`create` confirms only what the server can answer immediately; the full records
come back from `get` and `list`:

```typescript
interface Snapshot {
  id: string;
  name: string;
  version: number | null;   // latest ready version; null = nothing captured yet
  status: ArtifactStatus;   // "pending" | "ready" | "failed"
  sizeBytes: number;
  createdAt: Date | null;   // the first capture — it stays put
  updatedAt: Date | null;   // the most recent capture
  vcpu: number;             // the sizing the machine was captured at
  memoryBytes: number;
  useCount: number;         // machines restored from it so far
  storage: string;          // "local" | "archiving" | "archived" | "unarchiving"
  archived: boolean;        // true unless storage is "local": machines can't be created from it
}

interface Disk {
  id: string;
  name: string;
  sizeBytes: number;
  status: DiskStatus;       // "creating" | "ready" | "destroyed" — attach once "ready"
  createdAt: Date | null;
  attachments: {
    machineId: string;
    machineName: string;
    mountPath: string;
    mountMode: "ro" | "rw";
  }[];
}
```

## Custom domains

```typescript
const machine = await boxd.machines.get(id);
console.log(boxd.domains.dnsInstructions("app.example.com", {
  machineName: machine.name, machineIp: "<machine's public IP>",
  zone: (await boxd.account.config()).zone,
}));
// Point an A record at the machine's public IP, and a wildcard CNAME
// (*.app.example.com) at <machine>.<zone> — only once those are actually
// in place:
const domain = await boxd.domains.create({ domain: "app.example.com", machine: id });
domain.status;      // "pending" | "active"
domain.lastError;   // empty once active
await boxd.domains.list();
await boxd.domains.delete("app.example.com");
```

`create` binds the domain and starts verification immediately — call it only
once DNS is actually set. Checking before the records exist risks a public
DNS resolver caching the "no records" answer, which would delay verification
after you do set them. `dnsInstructions` is a local helper (no network call)
for rendering the records to show a user first — it doesn't touch the API. A
background check then verifies DNS and issues certs automatically, then
flips `status` to `"active"`.

## Organizations

```typescript
const orgs = await boxd.orgs.list();   // Org[]
orgs[0].id;
orgs[0].name;        // display label — it can repeat across organizations
orgs[0].slug;        // the organization's unique key
orgs[0].isAdmin;     // you administer it
orgs[0].isDefault;   // where your personal machines are billed
```

Anywhere a call takes `org`, it accepts an organization's name or id.

An org can also have a wildcard domain (e.g. `preview.mysaas.com`,
covering `<machine>.preview.mysaas.com` for every machine in the org).
Setting or clearing it requires org admin; reading it doesn't.

```typescript
// Delegate the apex's NS records to boxd's cluster nameservers at your
// registrar — only once that's actually done:
const d = await boxd.orgs.setDomain("acme", "preview.mysaas.com");   // starts "pending"
d.status, d.lastError;
await boxd.orgs.getDomain("acme");   // null if unset
await boxd.orgs.clearDomain("acme");
```

`setDomain` starts verification immediately — call it only once NS
delegation is actually live, for the same reason as per-machine domains
above. A background check then verifies delegation and issues certs
automatically, then flips `status` to `"active"`.

An org also has a default machine size: what a `create` that names no size
gets. It is a preference *below* the quota, not the quota itself — the quota
stays the operator-owned ceiling and the per-request maximum. Setting or
clearing it requires org admin; reading it doesn't.

```typescript
await boxd.orgs.setMachineDefaults("acme", { vcpu: 2 });   // or { memory: "8G" }
const d = await boxd.orgs.getMachineDefaults("acme");
d.isSet;                                  // false = no default; the values below
d.vcpu, d.memoryBytes;                    // are just the quota
d.ceilingVcpu, d.ceilingMemoryBytes;      // the org quota
await boxd.orgs.clearMachineDefaults("acme");   // back to the quota
```

Only machines created afterwards are affected — every existing machine keeps
the size it was created with. Omit the org to target your home org.

An org can also set whether its machines run with `idleIgnoreOutbound` on
(only inbound connections keep a machine awake). Setting it also sets it on
the existing machines and snapshots you can manage, unless you pass
`newMachinesOnly: true`. Setting or clearing it requires org admin; reading
it doesn't.

```typescript
const r = await boxd.orgs.setIdleIgnoreOutboundDefault("acme", { enabled: true });
r.machinesChanged, r.snapshotsChanged;    // existing machines and snapshots set
r.machinesSkipped;                        // others' private machines, left alone
await boxd.orgs.setIdleIgnoreOutboundDefault("acme", { enabled: true, newMachinesOnly: true });
const i = await boxd.orgs.getIdleIgnoreOutboundDefault("acme");
i.isSet, i.enabled;                       // isSet false = no default, so enabled is
i.platformEnabled;                        // the platform's setting, this one
await boxd.orgs.clearIdleIgnoreOutboundDefault("acme");  // existing machines keep theirs
```

An org has a machine limit: how many machines it may have at once. Any member
can read it; the org's owner can ask for a higher one, with their login or an
API key of theirs issued for the org. One request is open at a time, and the
owner gets an email when the limit changes.

```ts
const l = await boxd.orgs.getMachineLimit("acme");
l.maxVms, l.vmCount;                      // the limit, machines counting against it
l.isOwner;                                // true = you may ask for more
l.request;                                // the open request, or null
const r = await boxd.orgs.requestMachineLimit(100, { message: "CI runners", org: "acme" });
r.maxVms, r.requestedAt;                  // 100 in total, when it was asked
// a second one throws ConflictError until the limit changes; a member gets
// PermissionDeniedError
```

## Usage and cost

What each machine used and cost, and what was actually charged. Org owners
and admins only; an API key issued for the org works too.

```typescript
// One machine over its whole life, or pass { since, until } (Date or unix seconds).
// A deleted machine is found by its id or name ({ org } says where to look).
const u = await boxd.machines.usage("my-machine");
u.seconds.running; u.seconds.standby; u.seconds.hibernated; u.seconds.stopped;
u.costMicro / 1e6;   // estimated cost, in u.currency ("eur" | "usd")
u.complete;          // true once all its usage is metered (see below)
u.period.start; u.period.end;
u.vcpuHours; u.ramGibHours; u.diskGibHours;   // what the cost is priced on
u.rates;             // ...at these rates, per unit-hour

// Every machine in an org, most expensive first. Default: the last 28 days.
const r = await boxd.orgs.usage({ since: new Date("2026-09-01") });
r.totalCostMicro; r.currency;
for (const m of r.machines) console.log(m.name, m.status, m.costMicro / 1e6);

// Billing activity: what was actually charged, newest first.
for await (const e of boxd.orgs.billingActivity({ since: new Date("2026-09-01") })) {
  console.log(e.createdAt, e.kind, e.amountMicro / 1e6);   // charges are negative
}
```

To record what a machine cost after deleting it, wait for `complete`:
metering lags by up to ~25 minutes, so the figure read right after `delete()`
is still growing.

```typescript
await boxd.machines.delete(id);
// ...a little later, or from a periodic job:
const u = await boxd.machines.usage(id);
if (u.complete) save(id, u.costMicro, u.currency);   // otherwise try again later
```

`orgs.usage()` carries the same flag on every machine, so one periodic call can
settle all of them. A machine that still exists is never complete in a window
that runs to now.

Money is in micro-units (1e-6) of the org's currency. Usage is metered in
15-minute buckets and priced at the org's current rates, so it is an estimate
that tracks billing activity closely; billing activity is what was charged (one
`usage_charge` per 15 minutes for the whole org, plus top-ups and grants).
Machines deleted since still show up, with status `"deleted"`. A window spans
at most 366 days. `orgs.billingActivityPage()` returns one page with its
`nextPageToken` when you want to page by hand.

## Credentials and account

```typescript
const key = await boxd.apiKeys.create({
  name: "ci",
  org: "acme",                    // the organization the key is fenced to
  kind: "member",                 // "member" (default) acts as you within that org;
                                  // "org" is a userless service credential,
                                  // limited to the org's shared fleet, org admin only
  expiresIn: 60 * 60 * 24 * 30,   // seconds; omit or 0 for no expiry
});
key.id;
key.apiKey;      // shown once — store it now
key.expiresAt;   // Date | null

const keys = await boxd.apiKeys.list();
keys[0].name; keys[0].keyPrefix; keys[0].createdAt;
keys[0].lastUsedAt;   // Date | null — null = never used
keys[0].expiresAt;    // Date | null — null = no expiry
keys[0].org; keys[0].kind;   // "member" | "org"
await boxd.apiKeys.delete(key.id);

const me = await boxd.account.get();
me.userId;
me.displayName;          // string | null — falls back to `userId`
me.sshKeyFingerprints;   // string[]
me.billing.subscriptionStatus;   // "active", "trialing", … | null
me.billing.pastDueSince;         // Date | null
me.billing.maxVms;               // effective quota
me.billing.vcpu; me.billing.memoryBytes;

await boxd.account.linkSshKey({ pubkey: "ssh-ed25519 AAAA..." });
await boxd.account.linkSshKey({
  pubkey: "ssh-ed25519 AAAA...",
  deviceId: "laptop",     // one key kept per device — re-linking replaces it
  label: "MacBook Pro",   // shown wherever the device is listed
});

const cfg = await boxd.account.config();
cfg.defaultImage; cfg.zone;
```

Every key is fenced to exactly one organization. Deleting one takes effect
immediately.

## Errors

```typescript
import { NotFoundError } from "@boxd-sh/sdk";

try {
  await boxd.machines.get("nope");
} catch (e) {
  if (e instanceof NotFoundError) { /* ... */ }
}
```

Everything thrown extends `BoxdError`:

| Class | Meaning |
|---|---|
| `AuthenticationError` | boxd refused the credential, or none was found; `reason` is `missing_credentials`, `invalid_api_key` or `invalid_token` |
| `PermissionDeniedError` | authenticated, but not allowed; also an account that may not use the API (e.g. a disabled one) |
| `NotFoundError` | no such resource |
| `ConflictError` | already exists, the resource is in the wrong state, or it changed while the call ran |
| `AgentOutdatedError` | a `ConflictError`: the machine is too old for `machines.fs`; reboot it |
| `FilesystemError` | a `machines.fs` call failed inside the machine; `code` is the errno name (`ENOENT`, `EISDIR`, ...). Subclasses: `MachineFileNotFoundError`, `MachinePermissionError`, `MachineFileExistsError`, `MachineIsADirectoryError`, `MachineNotADirectoryError` |
| `RateLimitError` | quota or rate limit reached |
| `APIStatusError` | any other error returned by the server, or an unusable answer from the API-key exchange or the in-machine metadata adapter |
| `APIConnectionError` | the request never reached the server, or the API-key exchange or the in-machine metadata adapter couldn't be reached; the only class the client retries |

Every error carries `grpcCode`, the numeric
[status code](https://grpc.github.io/grpc/core/md_doc_statuscodes.html), for
finer-grained handling, and `reason` when the failure has a named one. An
error from plain HTTP (the API-key exchange, the in-machine metadata adapter)
also carries `httpStatus`, and
one from a failed connection its network error as `cause`.

## Async disposal

Node 20+, Bun, and Deno support TC39 explicit resource management:

```typescript
{
  await using boxd = new Boxd({ apiKey: "bxd_..." });
  await boxd.machines.list();
  // boxd.close() runs at scope exit
}
```

## Version notifications

The SDK prints a one-time `console.warn` on stderr when a newer release is
available:

```
A new version of @boxd-sh/sdk is available (v0.2.0, you have v0.1.9). Update with:
  npm install @boxd-sh/sdk@latest
```

It fires at most once per process and never causes a request to fail. The
installed version is also exported:

```typescript
import { VERSION } from "@boxd-sh/sdk";
```
