# boxd Python SDK

Python SDK for the [boxd](https://boxd.sh) cloud machine platform. Create
machines, run commands in them, move files, and manage everything around them.

Requires Python 3.10+.

## Install

```bash
pip install boxd
```

## Quick start

```python
from boxd import Boxd

boxd = Boxd(api_key="bxd_...")

machine = boxd.machines.create("my-machine")
boxd.machines.wait_until_ready(machine.id)

result = boxd.machines.exec(machine.id, "uname -a")
print(result.stdout)

# What it cost (metered every few minutes; still answers after delete):
usage = boxd.machines.usage(machine.id)
print(usage.cost_micro / 1e6, usage.currency)

boxd.machines.delete(machine.id)
boxd.close()
```

Everything follows the same shape: **`boxd.<resource>.<verb>(id, ...)`**.
Resources return plain data — a `Machine` has fields, not methods.

## Client

```python
Boxd()                                     # production
Boxd(api_key="bxd_...")
Boxd(base_url="https://boxd.example.com:9443")   # any other cluster
```

Every argument is keyword-only.

| Argument | Environment variable | Default |
|---|---|---|
| `api_key` | `BOXD_API_KEY` | — |
| `token` | `BOXD_TOKEN` | — |
| `base_url` | `BOXD_BASE_URL` (or the deprecated `BOXD_API_URL`) | `https://boxd.sh:9443` |
| `timeout` | — | 60.0 seconds |
| `max_retries` | — | 2 |

`base_url` accepts an optional scheme that controls TLS:

| Value | Transport |
|---|---|
| `http://host:port` | plaintext |
| `https://host:port` | TLS |
| bare `host:port` | TLS, except `localhost` / `127.*` |

`boxd.base_url` reports the cluster the client settled on.

The client holds a connection, so keep one around rather than making a new one
per call. Close it when you're done — or use it as a context manager:

```python
with Boxd(api_key="bxd_...") as boxd:
    ...
```

## Authentication

The first of these that is present wins:

1. `token=` — used as given
2. `api_key=` — exchanged for a short-lived credential and kept fresh for you
3. `BOXD_TOKEN`, then `BOXD_API_KEY`
4. running inside a boxd machine — see below
5. otherwise `AuthenticationError`

If your key is revoked mid-session, the SDK fails fast with
`AuthenticationError` rather than retrying.

`AuthenticationError` means only that no credential was found or boxd refused
it; its `.reason` says which (`"missing_credentials"`, `"invalid_api_key"`,
`"invalid_token"`). Failing to reach boxd is an `APIConnectionError`, an
account that can't use the API a `PermissionDeniedError`, and an error answer
from the key exchange an `APIStatusError` with its `.http_status`.

The exchange endpoint is **rate-limited per source IP** (30 requests / 60s). A
session token is valid for one hour, so a fleet of workers behind one NAT
should **mint one token and share it** (`Boxd(token=...)`) rather than each
process exchanging its own key. On a 429 the SDK waits out one `Retry-After`
before raising `RateLimitError`.

### Inside a machine

Inside a boxd machine, `Boxd()` authenticates automatically — no API key
needed, and it talks to that machine's own cluster unless you pass `base_url`.

```python
from boxd import Boxd

boxd = Boxd()
for machine in boxd.machines.list():
    print(machine.name, machine.status)
```

One limit: inside a **shared** machine the automatic credential can manage the
organization's shared machines, but cannot read environment variables or
secrets, and cannot reach private machines. Pass an API key for those.

An **isolated** machine has no automatic credential: `Boxd()` raises
`AuthenticationError` there, so pass an API key.

## Sync and async

`Boxd` and `AsyncBoxd` are the same surface — same namespaces, same method
names, same arguments, same return types. Switching is `await` and an import,
not a rewrite.

```python
from boxd import AsyncBoxd

boxd = AsyncBoxd(api_key="bxd_...")

machine = await boxd.machines.create("my-machine")
result = await boxd.machines.exec(machine.id, "echo hello")
await boxd.close()
```

`AsyncBoxd` is an async context manager too:

```python
async with AsyncBoxd(api_key="bxd_...") as boxd:
    ...
```

Two methods stay un-awaited, because they hand back something to iterate rather
than a result: `stream_exec` returns the session object directly, and `logs` is
an async generator you drive with `async for`.

Use `AsyncBoxd` when you already have an event loop (FastAPI, asyncio scripts,
anyio). Use `Boxd` everywhere else — scripts, notebooks, Django views.

## Machines

```python
machine = boxd.machines.create(
    "my-machine",
    vcpu=4,
    memory="16G",
    env={"MODE": "production"},
)
boxd.machines.get("my-machine")     # by name or id
boxd.machines.list()                     # a plain list
boxd.machines.list(org="acme")           # one organization's machines
boxd.machines.list(all_contexts=True)    # every org you belong to
boxd.machines.delete("my-machine")
```

Only `name` is positional; everything else is keyword-only. The full set of
create options:

```python
boxd.machines.create(
    "builder",
    image="ubuntu:24.04",
    org="acme",                   # create inside an organization
    shared=True,                  # and make it visible to every member
    env={"API_URL": "https://example.com"},
    cmd=["/usr/local/bin/start"],
    restart_policy="always",      # "always" | "never"
    vcpu=2,
    memory="8G",                  # sizes: 1 vCPU/4G, 2/8G, 4/16G, 8/32G
    disk="100G",
    auto_suspend_timeout=300,     # seconds; 0 disables
    auto_destroy_timeout=0,
    ssh=True,                     # False: SSH off, nothing answers on its port
    proxies=[ProxyEntry(name="api", port=3000)],
    volumes=[VolumeMount(disk_id="d_...", mount_path="/data", read_only=False)],
)

boxd.machines.create()            # every option is optional — cluster default image
```

`ProxyEntry` and `VolumeMount` are importable from `boxd`. A `ProxyEntry` with
`port=0` has its port detected inside the machine.

State:

```python
boxd.machines.start(id)
boxd.machines.stop(id)
boxd.machines.reboot(id)
boxd.machines.pause(id)        # suspend to RAM — fast to resume; PauseResult(suspend_us)
boxd.machines.resume(id)       # ResumeResult(resume_us)
boxd.machines.hibernate(id)    # suspend to disk — cheaper, slower to wake
boxd.machines.wake(id)
```

Everything else:

```python
boxd.machines.fork("my-machine", "my-copy")     # live clone
boxd.machines.fork(id, shared=True)             # forks keep the source machine's size
boxd.machines.rename(id, "new-name")            # returns the new name; reboots the machine
boxd.machines.share(id)                         # visible to your whole org
boxd.machines.unshare(id)
boxd.machines.set_auto_suspend_timeout(id, 300) # seconds idle; 0 disables
boxd.machines.set_auto_hibernate_timeout(id, 0)
boxd.machines.set_idle_ignore_outbound(id, True) # only inbound connections keep it awake
boxd.machines.set_ssh(id, False)                # nothing answers SSH; exec still works
boxd.machines.wait_until_ready(id)
boxd.machines.wait_until_ready(id, timeout=180.0, poll_interval=1.0)   # seconds
boxd.machines.suggest_name()
```

A fork inherits the source's sizing for anything you leave unset, and is
private to you unless you pass `shared=True`.

With SSH off (`ssh=False` on create, or `set_ssh(id, False)`), nothing
answers SSH on the machine's port, on the public address or the org's
network, and SSH sessions already open to it are closed. The port stays
allocated, so turning SSH back on keeps the address. `exec`, `boxd connect`
and the console terminal don't use SSH and keep working. A fork or a restore
keeps its source's setting unless you pass `ssh`. `set_ssh` can't be called
from inside the machine itself.

`create` and `fork` return once the machine is scheduled, not once it is
usable. Call `wait_until_ready` before doing anything that depends on it
running — especially before forking it again.

### Machine specs

A machine spec describes a machine in one value: what it boots from, its size,
labels, networks, isolation, egress, env, the secrets it gets, the
integrations and agent logins it needs, and the packages it installs on first boot. Build one from reusable pieces and create from it:

```python
from boxd import Machine, team, snapshot, github, slack, jira, claude, secrets

engineering = (
    Machine.spec()
    .from_(team("eng"))                  # a team's default snapshot; or snapshot("eng-base")
    .network("eng")
    .label("team", "eng")
    .env("NODE_ENV", "development")
    .packages("apt-get update", "apt-get install -y nginx")
    .with_(github(shared="eng-bot"), claude())
)

mike = engineering.size("2x8").with_(slack(), jira(shared="jira"), secrets("NPM_TOKEN"))
m = boxd.machines.create("mike-dev", org="acme", spec=mike)
m.spec           # the spec as it stands (update_spec, and label, network, egress and size edits, update it)
m.created_spec   # the spec it was created with, never changed
mike.resolve()   # the same spec as a dict, without creating anything
```

| Builder | Sets |
|---|---|
| `.from_(team(name))` / `.from_(snapshot(name))` | `base`. Omit for the default image. |
| `.size("1x4" \| "2x8" \| "4x16" \| …)` | `size`, `<vcpu>x<memory GiB>` |
| `.assign_to(user_id)` | `assignTo`: create the machine for another member of the org (below) |
| `.label(key, value)` / `.label({...})` | `labels` |
| `.network(*names)` | `networks` |
| `.isolated()` | `isolated` |
| `.egress(*hosts)` | `egress`: the machine's egress allowlist from birth |
| `.env(key, value)` / `.env({...})` | `env`: wins over org and personal vars of the same name |
| `.packages(*commands)` | `packages`: shell commands run once after the first boot (below) |
| `.with_(*pieces)` | merges pieces or other builders |

Pieces: `slack()`, `jira()`, `github()`, `asana()` (pass `shared="tag"` to use
the org connection shared under that tag instead of the owner's own),
`claude()`, `codex()`, and `secrets(*names)` (below). Integrations and agent logins are recorded on the
machine; a missing one never blocks the create (see "Integrations the machine
needs"). A piece is a plain dict (`{"labels": {...}}`, or
`{"connections": {"notion": "personal"}}` for any toolkit), so you can write your own.

Pieces merge in order: maps (`labels`, `env`, `connections`) merge with the
later piece winning, lists (`networks`, `egress`, `secrets`, `agents`,
`packages`) combine in order without duplicates, `isolated` only turns on, and `base`, `size` or `assignTo`
set twice to different values raises `MachineSpecError` (a `ValueError`). So
does a key a spec doesn't have, and a name in both `env` and `secrets`. The server checks every field and names it in its error
(`spec.size: ...`).

A spec carries its machine's base, size, labels, networks, isolation and env,
so `create(spec=...)` takes none of `image`, `env`, `labels`, `networks`,
`isolated`, `vcpu` or `memory` beside it. A spec whose base is a snapshot (or a
team with a default snapshot) restores it. A snapshot keeps its machine's spec:
restoring it gives the new machine that spec, and
`create(from_snapshot=..., spec=...)` merges a spec on top by the same rules;
its `size`, if set, must be the snapshot's. A fork keeps its source's spec.

#### Secrets

A spec names the secrets its machine gets; their values stay in
`boxd.secrets`. Usually they are `unattached` secrets, which reach no machine
until a spec lists them:

```python
boxd.secrets.set("NPM_TOKEN", "npm_…", scope="unattached", org="acme")

m = boxd.machines.create("mike-dev", org="acme", spec=engineering.with_(secrets("NPM_TOKEN")))
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
on any machine, and `update_spec` can't change that machine's own `egress` or
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
`bound_machines` says how many machines list it.

#### Creating a machine for someone else

An org owner or admin can create a machine for another member of the org with
`.assign_to(user_id)` (the member's user id, as `orgs.get_members()` lists it):

```python
m = boxd.machines.create(
    "mike-dev",
    org="acme",                          # required: the org the machine is for
    spec=engineering.size("2x8").assign_to("usr_e393f70e…"),
)
```

The machine is the member's from the start: private to them, billed to the
org, and set up with their own integrations and agent logins. You can't see or
reach it afterwards, so `create()` answers with its id and name only, and the
create can't also set `delete_after`. The member sees `created_by` (your user
id) and `created_by_name` on it. Refused, naming `spec.assignTo`: without
`org`, with `shared=True`, for a caller who isn't an owner or admin of the org,
with an org API key or from inside a machine, for someone who isn't a member,
and with a snapshot or disk the member couldn't use. Your own id is a plain
create. `assignTo` is never inherited: forks, snapshots and restores drop it.

The machine runs the spec you wrote as the member's own machine: its packages
as root, its env and its base, alongside the member's GitHub token, agent
logins and personal connections. Assign a spec only if the member would run it
themselves. The member sees who created it (`created_by`) and can read the
spec (`machine.spec`).

#### Integrations the machine needs

A spec's `connections` and `agents` are the machine's requirements. Reading the
machine (`get`, `list`, the machine `create` returns) tells you, for each one,
whether it is connected right now:

```python
m = boxd.machines.get("mike-dev")
for r in m.requirements:
    # kind="connection" name="jira" scope="shared" tag="jira" met=False can_fix=True reason=None
    print(r.name, r.scope, r.tag, "connected" if r.met else "connect it" if r.can_fix else r.reason or "ask an org admin")
```

A `personal` connection is the machine owner's own connection for that toolkit
in the machine's org (on a machine created with `assign_to`, the member's), a
`shared` one the org's connection shared under `tag`, and an agent the owner's
Claude Code or Codex sign-in. `can_fix` says whether you could connect it: the
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
and `update_spec(id, {}, retry_packages=True)` runs the failed command and the ones after it again (so does
Retry in the console's Packages section). To give up on a command instead, or
to replace a wrong one, remove it from the spec: a command that leaves the spec
before it finished is skipped, and the ones after it run. Reading the machine
tells you how each one went:

```python
m = boxd.machines.get("mike-dev")
for p in m.packages:
    # command="apt-get install -y nginx" state="failed" exit_code=100 output_tail="E: Unable to locate…" reason=None …
    print(p.state, p.exit_code, p.command)
```

`state` is `"pending"`, `"running"`, `"done"`, `"failed"` or `"skipped"`; the
commands after a failure stay `"pending"`. A pending or failed command that an
`update_spec` removes from the spec becomes `"skipped"`: it never runs and no
longer stops the ones after it, which run right away (or when the machine next
runs). A skipped one that failed keeps its `exit_code` and `output_tail`, and
`reason` says when it was skipped. Listing it in the spec again puts it back to
`"pending"`, in its place. So replacing a broken command is one patch: drop it
and add the corrected one, and the corrected one runs, with everything that
was waiting. A running command can't be removed (the patch is refused until it
ends), and removing a done one undoes nothing. `output_tail` is the last 4 KiB of the
command's output, with the value of every secret the machine gets shown as
`[secret NAME]` (only the value as it is: printed encoded or in pieces, it isn't
recognised). The log file isn't masked: it is root's, and root on the machine
can read its env anyway. `output_tail` is empty on the machines `list()` returns,
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
and 50 once duplicates are dropped. An `update_spec` patch is at most 256 KiB.

#### Updating a machine's spec

`update_spec` changes the spec of a machine created from one and applies what
changes. Pass a JSON Merge Patch, or a function that adds to the current spec:

```python
# Patch: a field left out is untouched, a scalar replaces, maps merge key by
# key (None removes a key), a list replaces the whole list, None removes a field.
boxd.machines.update_spec("mike-dev", {
    "labels": {"owner": "mike", "team": None},
    "networks": ["eng", "ops"],
    "packages": ["apt-get install -y nginx", "npm i -g pnpm"],
})

# Builder: reads the spec, adds with the composition rules, sends the difference.
boxd.machines.update_spec("mike-dev", lambda s: s.network("ops").env("LOG_LEVEL", "debug"))

# Dry run: the diff, nothing changed.
diff = boxd.machines.update_spec("mike-dev", {"size": "4x16"}, dry_run=True)
for c in diff.changes:
    print(c.field, c.apply, c.note, c.warnings)
if diff.reboot_required:
    boxd.machines.update_spec("mike-dev", {"size": "4x16"}, reboot=True)
```

Each change in `changes` says how it applies (`apply`):

| Field | `apply` |
|---|---|
| `labels`, `networks`, `egress` | `"live"` (new egress rules are in force within about a second of the call returning) |
| `connections`, `agents` | `"live"`: what the machine needs (`requirements`) changes |
| `packages` | `"live"`: added commands run now, after the ones before them. Removing one undoes nothing (a warning says so); a pending or failed one the patch removes is skipped (listed in `skipped`), so the ones after it run, and a skipped one listed again goes back to pending in its place (`unskipped`); a command that already ran isn't run again; commands after a failed one don't run (a warning says so) unless the update also retries (`retry_packages=True`: the failed command and the rest run again first, listed in `changed`, skipped ones excepted; a failed command the patch removes is skipped, not retried). Removing a running command is `"refused"` until it ends |
| `env`, `secrets` | `"reboot_recommended"`: new shells and exec sessions get them now; processes already running keep the old values until they restart (`reboot_recommended`) |
| `size` | `"reboot"` on a running machine, which reboots to apply it (as `resize`), so it needs `reboot=True`; `"live"` on a stopped one |
| `base`, `isolated`, `assignTo` | `"refused"`: fixed when the machine is created |

A refused change (also: new packages or a retry on a fork, a size change in standby or
hibernated) refuses the whole patch, and so does a reboot without
`reboot=True`; nothing is applied. So is an update during which the spec
changed (another update, a label edit): it raises `ConflictError`, and
reading the machine again and retrying is safe. The builder form does that
itself: it sends the spec it read, so a change made in between can't be
undone by its lists, and on a conflict reads the spec again and reapplies the
function, up to 3 times. A patch you built from a spec you read can say so
too, `expected_spec=machine.spec`: if the spec is no longer that one, nothing
is applied and it raises `ConflictError`. Otherwise the spec and the labels,
networks, egress and secrets it drives change together, then the size, then
the new packages run. If the size then fails (the org's quota changed, the
machine went to standby), the rest stays applied and the call still returns:
`resize_error` says why, and `spec` has the size the machine has. The patched spec is checked like a create's (an
unknown toolkit, a secret you may not list, more than 50 commands in all are
refused, naming the field). `machine.created_spec` never changes, so the
console shows the spec badge as "updated". Allowed to whoever may edit the
machine's labels: its owner, or an org owner or admin on a shared machine.
The builder form only adds: a `size` that differs from the spec's raises
(`"2X8"` is the same as `"2x8"`), so
use a patch to replace or remove. `spec_patch(from_spec, to_spec)` computes the
patch the builder form sends. `AsyncBoxd` has the same `await
boxd.machines.update_spec(...)`.

### Egress allowlist

A machine can be limited to what it may reach on the internet:

```python
boxd.machines.set_egress_allow("alpha", ["api.stripe.com", "*.github.com", "203.0.113.0/24"])
boxd.machines.get("alpha").egress_allow
boxd.machines.set_egress_allow("alpha", ["none"])   # nothing is reachable
boxd.machines.set_egress_allow("alpha", [])   # clear: unrestricted again
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

```python
m = boxd.machines.create("job-1", labels={"env": "prod", "run": "nightly"})
m.labels                                                    # {"env": "prod", "run": "nightly"}
boxd.machines.list(labels={"run": "nightly"})               # every pair must match
boxd.machines.list(labels=["env=prod", "gpu"])              # "key=value", or "key" = has the key
boxd.machines.update_labels("job-1", set={"owner": "ana"}, remove=["run"])
boxd.machines.update_labels("job-1", {"env": "dev"}, replace_all=True)  # set the whole set
```

Keys are 1-63 characters of lowercase letters, digits, `.`, `_`, `/` and `-`,
starting and ending with a letter or digit; the `boxd/` prefix is reserved.
Values are up to 256 characters and may be empty. A machine holds at most 64
labels. A fork or restore inherits its source's labels, and `labels=` on
`fork` or `create(from_snapshot=...)` is merged over them.

### Sizing

There are four sizes: 1 vCPU/4G, 2/8G, 4/16G, 8/32G. Name either dimension and
the other follows, so `vcpu=2` and `memory="8G"` are the same request. Anything
above your org's quota is refused, never quietly clamped.

A machine keeps the size it was created with, through stop/start, wake, and
migration alike. Changing it is an explicit call:

```python
result = boxd.machines.resize(id, memory="8G")   # or vcpu=2
result.vcpu, result.memory_bytes                 # the size now persisted
result.rebooted                                  # it was running, so it was rebooted
```

A **running** machine is rebooted to apply the new size: a cold boot, so the
disk survives and anything in RAM does not. A **stopped** machine takes it at
its next start. A suspended or hibernated machine is refused, because its
saved memory image is the old size — resume or wake it first.

A create that names no size uses the org default (see
[Organizations](#organizations-credentials-account)), and a fork always
inherits its source's size.

### The `Machine` record

```python
machine.id, machine.name, machine.image_ref
machine.status                  # "pending" | "starting" | "running" | "suspended" |
                                # "hibernated" | "stopped" | "failed" | "destroyed" |
                                # "migrating"
machine.restart_policy          # str | None
machine.created_at              # datetime | None — None when none is on record

machine.resources.vcpu          # what the machine actually got, not what you
machine.resources.memory_bytes  # asked for — always concrete
machine.resources.disk_bytes

machine.org                     # OrgRef(id, name) | None — None = personal quota
machine.shared                  # shared with that org, or private to you

machine.access.ssh_port         # int | None — None until allocated
machine.access.domain
machine.access.url              # https://<name>.<domain>
machine.ssh                     # bool — False: SSH is off, nothing answers on ssh_port

machine.idle.suspend_after      # seconds; 0 = that timer is disabled
machine.idle.hibernate_after
machine.idle.destroy_after

machine.source                  # MachineSource | None — None = booted from an image
machine.source.kind             # "fork" | "snapshot"
machine.source.name             # source machine, or snapshot name
machine.source.version          # int | None — snapshots only; a fork has none
machine.source.id               # str | None — provenance; may not resolve

machine.hibernated_at           # datetime | None — None = not hibernated
machine.last_connected_at       # datetime | None — None = never connected
machine.boot_time_ms            # int | None — last boot; None = never booted
machine.spec                    # dict | None — the machine spec it runs under
machine.created_spec            # dict | None — the spec it was created with
machine.created_by              # str | None — who created it for you (spec assignTo); None = you did
machine.created_by_name         # str | None — a name to show for created_by
machine.requirements            # list[MachineRequirement] — the spec's connections and agents:
                                #   kind, name, scope ("personal"/"shared"), tag, met, can_fix, reason
machine.packages                # list[MachinePackage] — the spec's packages and how each went:
                                #   command, state, exit_code, output_tail, reason, started_at, finished_at
                                #   (output_tail is empty from list(): get() has it)
```

`None` always means "not set": a port that was never allocated, a boot that
never happened, an org you do not have. Where `0` is a real answer — a disabled
idle timer — it stays `0`.

`org` is the org the machine belongs to and is billed to; `shared` says whether
your teammates can see it. A private machine can still be org-billed, so `org`
set with `shared=False` is normal, not a contradiction.

`source.id` points at the machine or snapshot this one came from. It is a record
of where the machine came from, not a live link — **it may not resolve**, and a
lookup that finds nothing is normal.

`MachineStatus` is importable from `boxd` when you want the literal type; a
status a newer server introduces is passed through as a plain string.

### Creating from a snapshot

```python
boxd.snapshots.create(machine_id, "golden")
machine = boxd.machines.create("from-golden", from_snapshot="golden")
```

Restoring a snapshot replays the machine as it was captured, so `from_snapshot`
goes with `name`, `org` and the sizing options. Combining it with `image`,
`env`, `cmd`, `restart_policy` or `shared` raises `ValueError`.

### Exec

```python
result = boxd.machines.exec(id, "cargo build")
result.stdout      # str
result.stderr      # str — populated for non-PTY execs
result.exit_code   # int
result.success     # bool

boxd.machines.exec(id, ["echo", "a b"])              # a list is quoted for you
boxd.machines.exec(id, "env", env={"FOO": "bar"})
boxd.machines.exec(id, "make", cwd="/srv/app")       # run from a working directory
boxd.machines.exec(id, "cargo build", timeout=30)    # seconds

# Under a PTY, stderr merges into stdout and `stderr` comes back empty.
boxd.machines.exec(id, "top -b -n1", tty=True, cols=120, rows=40)
```

`command` takes a list of argv — shell-quoted for you — or a ready-made command
line as a string. `cwd` runs the command from that directory; a `cwd` that
doesn't exist fails fast instead of silently running in the default
directory. `timeout` gives up on the call; whatever it started inside the
machine may well still be running.

**`result.stdout`/`result.stderr` are UTF-8-decoded with `errors="replace"`:**
any byte sequence that isn't valid UTF-8 is silently replaced with `U+FFFD`,
changing the length with no error raised. Fine for text output; corrupts
binary output. For binary or byte-exact output, read from `stream_exec`
instead — its chunks are raw `bytes`, never decoded:

```python
with boxd.machines.stream_exec(id, command="cat file.bin") as stream:
    data = b"".join(stream)   # byte-exact
```

For anything interactive, `stream_exec` gives you a live session — the one
handle in the SDK, because a bidirectional stream really is stateful:

```python
with boxd.machines.stream_exec(id, command="bash", tty=True) as stream:
    stream.write(b"ls\n")       # bytes or str
    stream.write_eof()          # half-close stdin; the process sees EOF
    for chunk in stream:        # bytes — merged output, what a terminal would show
        print(chunk.decode(errors="replace"), end="")
    print("exited", stream.exit_code)
```

`stream_exec` takes `command` and the rest as keywords, and hands back the
session without a round trip. `exit_code` is `None` until the stream is
exhausted. Leaving the `with` block — or calling `close()` — ends the session.

`iter_chunks()` yields `OutputChunk(data, is_stderr)` when you need the two
streams apart. Under `tty=True` the terminal merges them, so everything arrives
as stdout — set `tty=False` if you need the split.

For a headless one-shot that reads stdin (`jq`, `cat`, `claude -p`), pass
`close_stdin=True` so it sees end-of-input immediately instead of hanging.
Combining it with `tty=True` raises `ValueError` — a shell needs stdin open.

Set the terminal size with `cols`/`rows`, and call `stream.resize(cols, rows)`
when the local terminal changes size:

```python
import shutil, signal

cols, rows = shutil.get_terminal_size()
stream = boxd.machines.stream_exec(id, command="htop", tty=True, cols=cols, rows=rows)
signal.signal(signal.SIGWINCH, lambda *_: stream.resize(*shutil.get_terminal_size()))
```

### Logs

```python
for chunk in boxd.machines.logs(id):
    print(chunk.decode(errors="replace"), end="")

for chunk in boxd.machines.logs(id, follow=True):   # stays open
    ...
```

### Files

```python
from pathlib import Path

written = boxd.machines.files.upload(id, "/app/config.json", '{"debug": true}')
boxd.machines.files.upload(id, "/app/data.bin", Path("local.bin").read_bytes())
boxd.machines.files.upload(id, "notes.txt", "relative to /home/boxd")
data = boxd.machines.files.download(id, "/app/output.json")   # bytes
```

`upload` takes `str` or `bytes`, streams it in chunks so large files are fine,
and returns the number of bytes the machine confirmed it wrote. `download`
streams too and returns the whole file as `bytes` — there is no size cap, but
it is all held in memory. Paths are either absolute (`/app/config.json`) or
relative to the VM user's home directory (`/home/boxd`) — a bare filename
like `"notes.txt"` resolves to `/home/boxd/notes.txt`, same as `"./notes.txt"`
or `"sub/notes.txt"` would.

### Filesystem

`machines.fs` works on a machine's files the way code works on local ones: as
the machine's user, seeing the same files its commands do, with failures
raised as the builtin `OSError`s.

```python
fs = boxd.machines.fs

fs.write(id, "/app/config.json", '{"debug": true}')     # creates missing parents
fs.write(id, "big.bin", chunks)                          # or stream an iterable of bytes
data = fs.read(id, "/app/config.json")                   # bytes
for chunk in fs.read_stream(id, "big.bin"): ...          # without holding it all

entry = fs.stat(id, "/app")          # FsEntry: name, path, type, size, mode, mtime, ...
entry.is_dir, entry.is_symlink
fs.list(id, "/app")                  # one level, every entry
fs.exists(id, "/app/missing")        # False
fs.mkdir(id, "/app/a/b")             # mkdir -p
fs.rename(id, "/app/a", "/app/c")
fs.remove(id, "/app/c", recursive=True)
fs.realpath(id, "/app/link")

try:
    fs.read(id, "/app/nope")
except FileNotFoundError:
    ...
```

A write replaces the file all at once, so readers see the old contents or the
new, never a mix; only a file that can't be swapped by a rename (several hard
links, another user's file, a mount point) is overwritten in place. It writes
through a symlink to its target, and an existing file keeps its mode and owner
(or takes `mode=`). Only regular files can be read. Paths are `str`, `bytes` or
`os.PathLike`; a relative path starts in the user's home directory, and names
that aren't valid UTF-8 round-trip. Errors are
`MachineFilesystemError` subclasses that are also `FileNotFoundError`,
`PermissionError`, `FileExistsError`, `IsADirectoryError` or
`NotADirectoryError`, with `errno` and `filename` set. A machine started before
`machines.fs` existed raises `MachineAgentOutdatedError` until it is rebooted.

### Ports and proxies

```python
fwd = boxd.machines.ports.expose(id, 8080)            # public TCP forward
boxd.machines.ports.expose(id, 5353, protocol="udp")  # "tcp" | "udp" | "both"
fwd.dns, fwd.public_port, fwd.machine_port, fwd.protocol
fwd.machine_id, fwd.machine_name
boxd.machines.ports.unexpose(id, 8080)                # echoes back what it removed
boxd.machines.ports.list(id)                          # one machine's forwards
boxd.machines.ports.list()                            # every forward you own
```

Connect on `dns:public_port`. Max 3 forwards per machine. Re-exposing a machine
port keeps its public port and just updates the protocol set; `"both"` shares
one public port across TCP and UDP.

`ports.list()` is account-wide — pass a machine to narrow it, or filter on
`.machine_id` / `.machine_name`.

```python
route = boxd.machines.proxies.create("my-machine", "api", 3001)  # api.<machine>...
route.name, route.port
routes = boxd.machines.proxies.list("my-machine")
routes[0].name          # str | None — None on the machine's default route
routes[0].domain        # the hostname this route answers on
routes[0].port          # int — where traffic actually goes
routes[0].port_mode     # "locked" (you pinned it) | "auto" (detected for you)
routes[0].is_default
routes[0].machine_id, routes[0].machine_name
boxd.machines.proxies.set_port("my-machine", 3000, name="api")
boxd.machines.proxies.set_port("my-machine", "auto")  # default route, auto-detected
boxd.machines.proxies.delete("my-machine", "api")
```

These take an id or a name, like everything else on `machines`. `name` is a
subdomain label: lowercase letters, digits and hyphens, not starting or ending
with one. `create` answers as soon as the route is accepted, so it confirms the
subdomain and the port it was pointed at; `list()` reports the full domain and
the resolved port.

`port_mode="auto"` detection runs continuously for the whole life of the
machine, not just once at boot: whenever the app binds one of a curated list
of common ports (80, 443, 8080, 8000, 3000, 5000, 5173), that becomes a
candidate, and it's adopted once roughly 750ms have passed with no *different*
candidate port seen (an already-adopted port won't be replaced again more
than once every 5s). So a redeploy or restart that moves your app onto a new
port is picked up on its own within a few seconds — no action needed. If your
app doesn't listen on one of those ports, or you don't want to wait out the
detection window, call `set_port` with the port explicitly instead of `"auto"`.

### Checkpoints

Per-machine captures, restored in place. They are deleted with the machine.

```python
cp = boxd.machines.checkpoints.create(id, "before-upgrade")
cp.id, cp.name, cp.status
saved = boxd.machines.checkpoints.list(id)
saved[0].size_bytes
saved[0].created_at     # datetime
saved[0].created_by     # str | None
saved[0].available      # restorable right now — mirrors `status == "ready"`
boxd.machines.checkpoints.restore(id, "before-upgrade")
boxd.machines.checkpoints.delete(id, "before-upgrade")
```

The machine must be running to take a checkpoint. `status` is `"pending"` until
the artifact lands, then `"ready"` (or `"failed"`) — poll `status` for
`"ready"` to know when `restore` will succeed. `available` is a convenience
mirror of that same check (`False` for `"pending"`/`"failed"`, and also
`False` if the machine has since migrated off the checkpoint's worker even
though it's `"ready"`); it is never a separate readiness signal from `status`.

## Environment variables and secrets

Two namespaces with identical methods. The difference is that a secret's value
is write-only — the server never returns it, and the `Secret` model has no
`value` field at all.

```python
boxd.env.set("MODE", "production", scope="all")
boxd.env.list()                    # EnvVar(name, scope, value)
boxd.env.list(org="acme")
boxd.env.delete("MODE", scope="all")

boxd.secrets.set("API_TOKEN", "s3cr3t", scope="shared")
boxd.secrets.list()                # Secret(name, scope, domains, bound_machines) — no value
boxd.secrets.delete("API_TOKEN", scope="shared")
```

A secret can be bound to the hosts it may be sent to. The machine then only
ever holds a placeholder, and the real value is substituted into HTTPS
requests to those hosts on the way out:

```python
boxd.secrets.set("STRIPE_KEY", "sk_live_...", scope="all", domains=["api.stripe.com"])
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
and reports every scope. Pass `org="acme"` to any of these to work in an
organization instead of your personal scope. With an API key minted in an
organization your personal scope already lives there, so `org` is only needed
to reach the organization's `shared`/`all` vars.

`set`, `delete` and `move` each return the server's human-readable
confirmation of what it did.

Scope decides which machines a name applies to:

| Scope | Applies to |
|---|---|
| `private` | only your machines in that organization |
| `shared` | the organization's shared machines |
| `all` | every machine in the organization |
| `unattached` | secrets only: just the machines whose spec lists it ([Secrets](#secrets)); the organization's with `org` (set, moved and deleted by its owners and admins only), else your own |
| `private-unattached` | secrets only: your own unattached secret in the organization named by `org` |

`list` reports the organization's unattached secrets as `unattached` and your
own as `private-unattached`, each with `bound_machines`, the number of machines
whose spec lists it (0 for every other scope). `unattached` is for secrets
only: a plain value a machine needs belongs in its spec's `env`.

Scope is part of a name's identity — the same name can exist in several scopes
at once — so changing it is a `move` between two addresses, and both ends are
required:

```python
boxd.secrets.move("API_TOKEN", from_scope="private", to_scope="shared")
```

Calling it twice fails the second time. Environment variables and secrets share
one namespace within a scope, so an environment variable can block a secret of
the same name moving in, and vice versa.

## Snapshots and disks

```python
snap = boxd.snapshots.create(machine_id, "golden")   # re-saving bumps the version
snap.id, snap.name, snap.version, snap.status
boxd.snapshots.get("golden")                         # by name or id
boxd.snapshots.list()
boxd.snapshots.delete("golden")
boxd.snapshots.list(org="acme")      # `org` works on get/list/delete too

disk = boxd.disks.create("data", "10G")   # bytes or a human string
disk.id, disk.name, disk.size_bytes, disk.status
boxd.disks.attach(disk.id, machine_id, "/mnt/data")
boxd.disks.attach(disk.id, machine_id, "/mnt/data", read_only=True)
boxd.disks.detach(disk.id, machine_id)
boxd.disks.list()
boxd.disks.delete(disk.id)
```

The machine must be running to snapshot it, and `create` answers before the
artifact lands — `status` is `"pending"` until it does. Snapshots stay inside
one organization.

A disk is always created writable; read-only is chosen per attachment. A disk
can be attached to only one machine at a time.

`create` confirms only what the server can answer immediately; the full records
come back from `get` and `list`:

```python
snapshot = boxd.snapshots.get("golden")
snapshot.id, snapshot.name
snapshot.version        # int | None — latest ready version; None = nothing captured yet
snapshot.status         # "pending" | "ready" | "failed"
snapshot.size_bytes
snapshot.created_at     # datetime | None — the first capture; it stays put
snapshot.updated_at     # datetime | None — the most recent capture
snapshot.vcpu           # the sizing the machine was captured at
snapshot.memory_bytes
snapshot.use_count      # machines restored from it so far
snapshot.storage        # "local" | "archiving" | "archived" | "unarchiving"
snapshot.archived       # True unless storage is "local": machines can't be created from it

volume = boxd.disks.list()[0]
volume.id, volume.name, volume.size_bytes
volume.status           # "creating" | "ready" | "destroyed" — attach once "ready"
volume.created_at       # datetime | None
volume.attachments      # [DiskAttachment(machine_id, machine_name, mount_path, mount_mode)]
                        # mount_mode is "ro" or "rw"
```

## Custom domains

```python
machine = boxd.machines.get(machine_id)
print(boxd.domains.dns_instructions(
    "app.example.com", machine_name=machine.name, machine_ip="<machine's public IP>",
    zone=boxd.account.config().zone,
))
# Point an A record at the machine's public IP, and a wildcard CNAME
# (*.app.example.com) at <machine>.<zone> — only once those are actually in
# place:
domain = boxd.domains.create("app.example.com", machine_id)   # starts "pending"
domain.status           # "pending" | "active"
domain.last_error       # empty once active
boxd.domains.list()
boxd.domains.delete("app.example.com")
```

`create` binds the domain and starts verification immediately — call it only
once DNS is actually set. Checking before the records exist risks a public
DNS resolver caching the "no records" answer, which would delay verification
after you do set them. `dns_instructions` is a local helper (no network
call) for rendering the records to show a user first — it doesn't touch the
API. A background check verifies DNS and issues certs automatically, then
flips `status` to `"active"`.

## Organizations, credentials, account

```python
orgs = boxd.orgs.list()              # a plain list
orgs[0].id
orgs[0].name                         # display label — it can repeat across organizations
orgs[0].slug                         # the organization's unique key
orgs[0].is_admin                     # you administer it
orgs[0].is_default                   # where your personal machines are billed
```

Anywhere a call takes `org`, it accepts an organization's name or id.

An org can also have a wildcard domain (e.g. `preview.mysaas.com`,
covering `<machine>.preview.mysaas.com` for every machine in the org).
Setting or clearing it requires org admin; reading it doesn't.

```python
# Delegate the apex's NS records to boxd's cluster nameservers at your
# registrar — only once that's actually done:
d = boxd.orgs.set_domain("acme", "preview.mysaas.com")   # starts "pending"
d.status, d.last_error
boxd.orgs.get_domain("acme")     # None if unset
boxd.orgs.clear_domain("acme")
```

`set_domain` starts verification immediately — call it only once NS
delegation is actually live, for the same reason as per-machine domains
above. A background check then verifies delegation and issues certs
automatically, then flips `status` to `"active"`.

An org also has a default machine size: what a `create` that names no size
gets. It is a preference *below* the quota, not the quota itself — the quota
stays the operator-owned ceiling and the per-request maximum. Setting or
clearing it requires org admin; reading it doesn't.

```python
boxd.orgs.set_machine_defaults("acme", vcpu=2)     # or memory="8G"
d = boxd.orgs.get_machine_defaults("acme")
d.is_set                                           # False = no default; the values
d.vcpu, d.memory_bytes                             # below are just the quota
d.ceiling_vcpu, d.ceiling_memory_bytes             # the org quota
boxd.orgs.clear_machine_defaults("acme")           # back to the quota
```

Only machines created afterwards are affected — every existing machine keeps
the size it was created with. Omit the org to target your home org.

An org can also set whether its machines run with `idle_ignore_outbound` on
(only inbound connections keep a machine awake). Setting it also sets it on
the existing machines and snapshots you can manage, unless you pass
`new_machines_only=True`. Setting or clearing it requires org admin; reading
it doesn't.

```python
r = boxd.orgs.set_idle_ignore_outbound_default("acme", enabled=True)
r.machines_changed, r.snapshots_changed            # existing machines and snapshots set
r.machines_skipped                                 # others' private machines, left alone
boxd.orgs.set_idle_ignore_outbound_default("acme", enabled=True, new_machines_only=True)
i = boxd.orgs.get_idle_ignore_outbound_default("acme")
i.is_set, i.enabled                                # is_set False = no default, so enabled is
i.platform_enabled                                 # the platform's setting, this one
boxd.orgs.clear_idle_ignore_outbound_default("acme")  # existing machines keep theirs
```

An org has a machine limit: how many machines it may have at once. Any member
can read it; the org's owner can ask for a higher one, with their login or an
API key of theirs issued for the org. One request is open at a time, and the
owner gets an email when the limit changes.

```python
l = boxd.orgs.get_machine_limit("acme")
l.max_vms, l.vm_count                              # the limit, machines counting against it
l.is_owner                                         # True = you may ask for more
l.request                                          # the open request, or None
r = boxd.orgs.request_machine_limit(100, message="CI runners", org="acme")
r.max_vms, r.requested_at                          # 100 in total, when it was asked
# a second one raises ConflictError until the limit changes; a member gets
# PermissionDeniedError
```

```python
key = boxd.api_keys.create(
    "ci",
    org="acme",                      # the organization the key is fenced to
    kind="member",                   # "member" (default) acts as you within that org;
                                     # "org" is a userless service credential, limited
                                     # to the org's shared fleet, org admin only
    expires_in=60 * 60 * 24 * 30,    # seconds; 0 for no expiry
)
key.id
key.api_key                          # the raw key — shown once, store it now
key.expires_at                       # datetime | None

keys = boxd.api_keys.list()
keys[0].name, keys[0].key_prefix, keys[0].created_at
keys[0].last_used_at                 # datetime | None — None = never used
keys[0].expires_at                   # datetime | None — None = no expiry
keys[0].org, keys[0].kind            # "member" | "org"
boxd.api_keys.delete(key.id)
```

Every key is fenced to exactly one organization. Deleting one takes effect
immediately.

```python
from pathlib import Path

me = boxd.account.get()
me.user_id
me.display_name                      # str | None — falls back to `user_id`
me.pubkey_fingerprints               # list[str]
me.billing.subscription_status       # "active", "trialing", … | None
me.billing.past_due_since            # datetime | None
me.billing.max_vms                   # effective quota
me.billing.vcpu, me.billing.memory_bytes

pubkey = (Path.home() / ".ssh/id_ed25519.pub").read_text()
boxd.account.link_ssh_key(pubkey)
boxd.account.link_ssh_key(
    pubkey,
    device_id="laptop",              # one key kept per device — re-linking replaces it
    label="MacBook Pro",             # shown wherever the device is listed
)

cfg = boxd.account.config()
cfg.default_image, cfg.zone
```

## Usage and cost

What each machine used and cost, and what was actually charged. Org owners
and admins only; an API key issued for the org works too.

```python
from datetime import datetime, timezone

# One machine over its whole life, or pass since=/until= (datetime or unix
# seconds). A deleted machine is found by its id or name (org= says where to look).
u = boxd.machines.usage("my-machine")
u.seconds.running, u.seconds.standby, u.seconds.hibernated, u.seconds.stopped
u.cost_micro / 1e6                   # estimated cost, in u.currency ("eur" | "usd")
u.complete                           # True once all its usage is metered (see below)
u.period.start, u.period.end
u.vcpu_hours, u.ram_gib_hours, u.disk_gib_hours   # what the cost is priced on
u.rates                              # ...at these rates, per unit-hour

# Every machine in an org, most expensive first. Default: the last 28 days.
r = boxd.orgs.usage(since=datetime(2026, 9, 1, tzinfo=timezone.utc))
r.total_cost_micro, r.currency
for m in r.machines:
    print(m.name, m.status, m.cost_micro / 1e6)

# Billing activity: what was actually charged, newest first.
for e in boxd.orgs.billing_activity(since=datetime(2026, 9, 1, tzinfo=timezone.utc)):
    print(e.created_at, e.kind, e.amount_micro / 1e6)   # charges are negative
```

To record what a machine cost after deleting it, wait for `complete`:
metering lags by up to ~25 minutes, so the figure read right after `delete()`
is still growing.

```python
boxd.machines.delete(machine_id)
# ...a little later, or from a periodic job:
u = boxd.machines.usage(machine_id)
if u.complete:
    save(machine_id, u.cost_micro, u.currency)   # otherwise try again later
```

`orgs.usage()` carries the same flag on every machine, so one periodic call can
settle all of them. A machine that still exists is never complete in a window
that runs to now.

Money is in micro-units (1e-6) of the org's currency. Usage is metered in
15-minute buckets and priced at the org's current rates, so it is an estimate
that tracks billing activity closely; billing activity is what was charged (one
`usage_charge` per 15 minutes for the whole org, plus top-ups and grants).
Machines deleted since still show up, with status `"deleted"`. A window spans
at most 366 days. `orgs.billing_activity_page()` returns one page with its
`next_page_token` when you want to page by hand. The async client has the
same methods (`async for e in boxd.orgs.billing_activity(): ...`).

## Errors

```python
from boxd import (
    BoxdError,               # base class — catch this to catch everything
    AuthenticationError,     # no usable credential, or it was rejected
    PermissionDeniedError,   # authenticated, but not allowed
    NotFoundError,
    ConflictError,           # already exists, fights the current state, or it changed meanwhile
    RateLimitError,          # rate limit or quota
    APIStatusError,          # any other error from the server
    APIConnectionError,      # could not reach the server
)

try:
    boxd.machines.get("nope")
except NotFoundError:
    ...
```

Every error carries `.message`, `.code` (the canonical status name, e.g.
`"not_found"`) and `.grpc_code`, the numeric
[status code](https://grpc.github.io/grpc/core/md_doc_statuscodes.html). Some
also carry `.reason`, a name for the exact failure (`"invalid_api_key"`,
`"is_a_directory"`, ...), and errors from the key exchange carry
`.http_status`. `machines.fs` errors are also `OSError`s (see
[Filesystem](#filesystem)).

Connection failures are retried with exponential backoff, `max_retries` times,
including failing to reach the key exchange or a machine's automatic credential.
Timeouts are never retried — the server may already have applied the request —
and neither is `AuthenticationError`.

## Update notices

The SDK prints a one-time note to stderr if the server reports a newer release:

```
A new version of boxd is available (v0.2.0, you have v0.1.9). Update with:
  pip install --upgrade boxd
```

It fires at most once per process and never causes a request to fail.

The installed version is available as `boxd.__version__`.
