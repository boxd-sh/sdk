# boxd SDKs

The official SDKs for [boxd](https://boxd.sh), the cloud machine platform:
create machines, run commands in them, move files, and manage everything
around them.

| Language | Package | Folder |
|---|---|---|
| Python 3.10+ | [`boxd`](https://pypi.org/project/boxd/) | [`python/`](python/) |
| TypeScript (Node 20+, Bun, Deno) | [`@boxd-sh/sdk`](https://www.npmjs.com/package/@boxd-sh/sdk) | [`typescript/`](typescript/) |

Both SDKs are generated from the same API definition,
[`proto/api.proto`](proto/api.proto), and ship together under one version.
Each folder's README covers installation and usage.

## Quick start

```bash
pip install boxd
```

```python
from boxd import Boxd

boxd = Boxd(api_key="bxd_...")
machine = boxd.machines.create("my-machine")
boxd.machines.wait_until_ready(machine.id)
print(boxd.machines.exec(machine.id, "uname -a").stdout)
```

```bash
npm install @boxd-sh/sdk
```

```typescript
import { Boxd } from "@boxd-sh/sdk";

const boxd = new Boxd({ apiKey: "bxd_..." });
const machine = await boxd.machines.create({ name: "my-machine" });
await boxd.machines.waitUntilReady(machine.id);
console.log((await boxd.machines.exec(machine.id, { command: ["uname", "-a"] })).stdout);
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
