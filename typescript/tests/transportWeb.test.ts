/**
 * `WebTransport` against a minimal local server that speaks
 * grpc-web framing (https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)
 * for every RPC, `Exec` and `UploadFileStream` included — both run
 * half-duplex: the whole framed request body (possibly many message
 * frames) arrives in one POST, then the response streams back.
 *
 * This is the client-side twin of the server's own grpc-web tests, which
 * pin the SAME protocol from the server side against a real router.
 * Together they cover the web transport end to end: create, GetVm, ListVms, upload (small + streamed >4 MiB),
 * download, exec with stdin + exit code, destroy.
 *
 * The server here is a deliberately small stand-in, not the real proxy —
 * it exists to validate `WebTransport`'s framing/parsing against a
 * conformant peer without needing a live boxd cluster (which needs KVM).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebTransport } from "../src/_transportWeb.js";
import { Machines } from "../src/machines.js";
import { MachineFiles } from "../src/files.js";
import { MachineFs } from "../src/fs.js";
import { Credentials } from "../src/auth.js";
import {
  BoxdApiDefinition,
  CreateVmRequest,
  CreateVmResponse,
  DestroyVmResponse,
  DownloadFileChunk,
  DownloadFileRequest,
  ExecChunk,
  FsEntryType,
  FsMkdirRequest,
  FsReadChunk,
  FsReadRequest,
  FsStatRequest,
  FsWriteChunk,
  FsWriteResponse,
  GetVmRequest,
  GetVmResponse,
  ListVmsRequest,
  ListVmsResponse,
  UploadFileChunk,
  UploadFileResponse,
} from "../src/_generated/definitions.js";
import {
  AgentOutdatedError,
  AuthenticationError,
  BoxdError,
  FilesystemError,
  NotFoundError,
} from "../src/errors.js";

// ── grpc-web framing (client side of the wire, so tests can build valid
//    responses without depending on _transportWeb.ts's own private helpers)

function frame(payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(5 + payload.length);
  new DataView(f.buffer).setUint32(1, payload.length, false);
  f.set(payload, 5);
  return f;
}
const TRAILER_FLAG = 0x80;

function messageFrame(payload: Uint8Array): Uint8Array {
  return frame(payload); // flag byte is already 0
}
function trailerFrame(status: number, message = "", reason?: string): Uint8Array {
  // Real `tonic::Status::to_header_map` percent-encodes `grpc-message`
  // (verified in `tonic-0.13.1/src/status.rs`) — encode here too so these
  // tests exercise `_transportWeb.ts`'s decode side, not just its no-op case.
  const text =
    `grpc-status:${status}\r\ngrpc-message:${encodeURIComponent(message)}\r\n` +
    (reason ? `x-boxd-error-reason:${reason}\r\n` : "");
  const f = frame(new TextEncoder().encode(text));
  f[0] = TRAILER_FLAG;
  return f;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A trailers-only rejection — status/message as leading headers, empty
 *  body. Real shape for any RPC whose handler returns `Err(status)` before
 *  ever producing a `Response` (verified against the real proxy, whose own
 *  grpc-web tests pin the same shape). */
function trailersOnlyRejection(status: number, message: string, reason?: string): Response {
  const headers: Record<string, string> = {
    "grpc-status": String(status),
    "grpc-message": encodeURIComponent(message),
  };
  if (reason) headers["x-boxd-error-reason"] = reason;
  return new Response(null, { status: 200, headers });
}

/** A file's entry, as the filesystem RPCs describe one. */
function fsEntry(path: string, size: number) {
  return {
    name: new TextEncoder().encode(path.split("/").pop()!),
    path: new TextEncoder().encode(path),
    type: FsEntryType.FS_ENTRY_TYPE_FILE,
    targetType: FsEntryType.FS_ENTRY_TYPE_FILE,
    size,
    mode: 0o644,
    mtimeNs: 0,
    uid: 1000,
    gid: 1000,
    symlinkTarget: new Uint8Array(),
  };
}

/** Decode a grpc-web request body down to its message frames, in order —
 *  `Exec`/`UploadFileStream` carry more than one when the caller wrote more
 *  than once before `end()`. */
function readGrpcWebFrames(buf: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let rest = buf;
  while (rest.length >= 5) {
    const len = new DataView(rest.buffer, rest.byteOffset + 1, 4).getUint32(0, false);
    frames.push(rest.subarray(5, 5 + len));
    rest = rest.subarray(5 + len);
  }
  return frames;
}
async function readGrpcWebRequest(req: Request): Promise<Uint8Array[]> {
  return readGrpcWebFrames(new Uint8Array(await req.arrayBuffer()));
}

/** Minimal stand-in for the boxd proxy's grpc-web tree. */
function startMockProxy() {
  let getVmCalls = 0;
  let execCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (!auth?.startsWith("Bearer ")) {
        return trailersOnlyRejection(16, "missing bearer token");
      }

      const method = url.pathname.split("/").pop();
      const frames = await readGrpcWebRequest(req);

      switch (method) {
        case "GetVm": {
          const r = GetVmRequest.decode(frames[0]!);
          if (r.vmId === "never-responds") {
            // Never resolves — the client's own `AbortSignal.timeout()` is
            // what ends this call, not the server. Used to prove a
            // client-side deadline isn't retried: retrying a
            // non-idempotent call whose deadline merely expired — the
            // server may still be processing it — risks duplicating it.
            getVmCalls++;
            await new Promise(() => {});
          }
          if (r.vmId === "does-not-exist") return trailersOnlyRejection(5, "VM not found");
          const resp = GetVmResponse.fromPartial({
            vmId: "vm-1",
            name: r.vmId,
            status: "running",
            imageRef: "debian:12",
          });
          return new Response(
            concat(messageFrame(GetVmResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "ListVms": {
          ListVmsRequest.decode(frames[0]!);
          const resp = ListVmsResponse.fromPartial({
            vms: [
              GetVmResponse.fromPartial({ vmId: "vm-1", name: "alpha", status: "running" }),
              GetVmResponse.fromPartial({ vmId: "vm-2", name: "beta", status: "stopped" }),
            ],
          });
          return new Response(
            concat(messageFrame(ListVmsResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "CreateVm": {
          const r = CreateVmRequest.decode(frames[0]!);
          const resp = CreateVmResponse.fromPartial({ vmId: "vm-new", name: r.name || "auto" });
          return new Response(
            concat(messageFrame(CreateVmResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "DestroyVm": {
          const resp = DestroyVmResponse.fromPartial({});
          return new Response(
            concat(messageFrame(DestroyVmResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "DownloadFileStream": {
          const r = DownloadFileRequest.decode(frames[0]!);
          const payload = new TextEncoder().encode(`contents of ${r.path}`);
          const chunk = DownloadFileChunk.fromPartial({
            data: payload,
            totalSize: payload.length,
          });
          return new Response(
            concat(messageFrame(DownloadFileChunk.encode(chunk).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "Exec": {
          execCalls++;
          const start = ExecChunk.decode(frames[0]!);
          if (start.vmId === "does-not-exist") return trailersOnlyRejection(5, "VM not found");
          if (start.tty) {
            return trailersOnlyRejection(12, "PTY sessions aren't available over grpc-web");
          }
          // Whole request already arrived (half-duplex) — every frame past
          // the start chunk carries stdin. Echo it back as one stdout
          // chunk, then the exit code, then the trailer: the same shape
          // `run_exec` produces on the real proxy.
          const stdinParts = frames
            .slice(1)
            .map((f) => ExecChunk.decode(f))
            .filter((c) => c.stdin)
            .map((c) => c.data);
          const parts: Uint8Array[] = [];
          if (stdinParts.length > 0) {
            const data = concat(...stdinParts);
            parts.push(messageFrame(ExecChunk.encode(ExecChunk.fromPartial({ data })).finish()));
          }
          parts.push(
            messageFrame(ExecChunk.encode(ExecChunk.fromPartial({ exitCode: 0 })).finish()),
          );
          parts.push(trailerFrame(0));
          return new Response(concat(...parts), {
            headers: { "content-type": "application/grpc-web+proto" },
          });
        }
        case "UploadFileStream": {
          const first = UploadFileChunk.decode(frames[0]!);
          if (first.vmId === "does-not-exist") return trailersOnlyRejection(5, "VM not found");
          let received = first.data.length;
          for (const f of frames.slice(1)) received += UploadFileChunk.decode(f).data.length;
          const resp = UploadFileResponse.fromPartial({ bytesWritten: received });
          return new Response(
            concat(messageFrame(UploadFileResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        case "FsStat": {
          const r = FsStatRequest.decode(frames[0]!);
          const path = new TextDecoder().decode(r.path);
          if (path === "/outdated") {
            return trailersOnlyRejection(9, "agent too old", "agent_outdated");
          }
          return trailersOnlyRejection(5, `no such file: ${path}`, "not_found");
        }
        case "FsMkdir": {
          FsMkdirRequest.decode(frames[0]!);
          // A failure after the call started: an empty body with the reason
          // in the trailer frame, not the headers.
          return new Response(trailerFrame(6, "a file is in the way", "file_exists"), {
            headers: { "content-type": "application/grpc-web+proto" },
          });
        }
        case "FsRead": {
          const r = FsReadRequest.decode(frames[0]!);
          const path = new TextDecoder().decode(r.path);
          const parts: Uint8Array[] = [];
          const chunk = (c: Partial<FsReadChunk>) =>
            messageFrame(FsReadChunk.encode(FsReadChunk.fromPartial(c)).finish());
          if (path === "/fails-midway") {
            parts.push(chunk({ entry: fsEntry(path, 9), data: new TextEncoder().encode("part") }));
            parts.push(trailerFrame(13, "input/output error", "io_error"));
          } else {
            const body = new TextEncoder().encode(`contents of ${path}`);
            parts.push(chunk({ entry: fsEntry(path, body.length), data: body.subarray(0, 5) }));
            parts.push(chunk({ data: body.subarray(5) }));
            parts.push(chunk({ eof: true, bytesRead: body.length }));
            parts.push(trailerFrame(0));
          }
          return new Response(concat(...parts), {
            headers: { "content-type": "application/grpc-web+proto" },
          });
        }
        case "FsWrite": {
          const chunks = frames.map((f) => FsWriteChunk.decode(f));
          const path = new TextDecoder().decode(chunks[0]!.path);
          const total = chunks.reduce((n, c) => n + c.data.length, 0);
          if (chunks[0]!.expectedSize !== undefined && chunks[0]!.expectedSize !== total) {
            return trailersOnlyRejection(10, "size mismatch", "size_mismatch");
          }
          const resp = FsWriteResponse.fromPartial({ bytesWritten: total, entry: fsEntry(path, total) });
          return new Response(
            concat(messageFrame(FsWriteResponse.encode(resp).finish()), trailerFrame(0)),
            { headers: { "content-type": "application/grpc-web+proto" } },
          );
        }
        default:
          return trailersOnlyRejection(12, `unimplemented: ${method}`);
      }
    },
  });
  return {
    httpOrigin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    get getVmCalls() {
      return getVmCalls;
    },
    get execCalls() {
      return execCalls;
    },
  };
}

function transportAgainst(origin: { httpOrigin: string }, token = "test-token") {
  return new WebTransport({
    creds: new Credentials({ token, exchangeUrl: "https://example.invalid" }),
    explicitBaseURL: origin.httpOrigin,
    defaultBaseURL: origin.httpOrigin,
    timeoutMs: 5_000,
    maxRetries: 0,
  });
}

let proxy: ReturnType<typeof startMockProxy> | undefined;
afterEach(() => {
  proxy?.stop();
  proxy = undefined;
});

describe("WebTransport: unary (grpc-web)", () => {
  it("GetVm decodes a real message frame", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const resp = await t.unary(BoxdApiDefinition.methods.getVm, { vmId: "alpha" });
    expect(resp.name).toBe("alpha");
    expect(resp.status).toBe("running");
  });

  it("ListVms decodes a repeated field", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const resp = await t.unary(BoxdApiDefinition.methods.listVms, { org: "", allContexts: false, labelSelector: [] });
    expect(resp.vms.map((v) => v.name)).toEqual(["alpha", "beta"]);
  });

  it("CreateVm then DestroyVm — the create/destroy half of the acceptance list", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const created = await t.unary(
      BoxdApiDefinition.methods.createVm,
      CreateVmRequest.fromPartial({ name: "fresh" }),
    );
    expect(created.vmId).toBe("vm-new");
    await t.unary(BoxdApiDefinition.methods.destroyVm, { vmId: created.vmId });
  });

  it("a trailers-only rejection (no auth) maps to AuthenticationError", async () => {
    proxy = startMockProxy();
    const t = new WebTransport({
      creds: new Credentials({ exchangeUrl: "https://example.invalid" }),
      explicitBaseURL: proxy.httpOrigin,
      defaultBaseURL: proxy.httpOrigin,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    // No token/apiKey/env credential configured at all -> Credentials itself
    // refuses before a request is ever sent.
    await expect(t.unary(BoxdApiDefinition.methods.getVm, { vmId: "x" })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("a NotFound trailer (message frame + trailer, not headers) maps to NotFoundError", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    await expect(
      t.unary(BoxdApiDefinition.methods.getVm, { vmId: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a client-side deadline is never retried, even with retries configured", async () => {
    proxy = startMockProxy();
    const t = new WebTransport({
      creds: new Credentials({ token: "test-token", exchangeUrl: "https://example.invalid" }),
      explicitBaseURL: proxy.httpOrigin,
      defaultBaseURL: proxy.httpOrigin,
      timeoutMs: 50,
      maxRetries: 3,
    });
    // A slow call (e.g. `machines.create`) that merely times out may have
    // already been applied server-side — retrying it would duplicate the
    // resource. Assert both that the call still fails AND that it was only
    // ever attempted once, despite `maxRetries: 3`.
    await expect(
      t.unary(BoxdApiDefinition.methods.getVm, { vmId: "never-responds" }),
    ).rejects.toThrow();
    expect(proxy.getVmCalls).toBe(1);
  });
});

describe("WebTransport: server-streaming (grpc-web)", () => {
  it("download reassembles a DownloadFileStream", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const call = t.serverStream(
      BoxdApiDefinition.methods.downloadFileStream,
      DownloadFileRequest.fromPartial({ vmId: "alpha", path: "/etc/hostname" }),
    );
    const chunks: DownloadFileChunk[] = [];
    const done = new Promise<void>((resolve, reject) => {
      call.on("data", (c) => chunks.push(c));
      call.on("error", reject);
      call.on("end", () => resolve());
    });
    await done;
    const text = new TextDecoder().decode(chunks[0]!.data);
    expect(text).toBe("contents of /etc/hostname");
  });
});

describe("WebTransport: Exec / UploadFileStream over grpc-web, half-duplex", () => {
  it("exec: writes stdin, gets stdout + exit code back from one POST/response round-trip", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const call = t.duplex<ExecChunk, ExecChunk>(BoxdApiDefinition.methods.exec);

    const out: Uint8Array[] = [];
    let exitCode: number | undefined;
    const done = new Promise<void>((resolve, reject) => {
      call.on("data", (chunk) => {
        if (chunk.data.length > 0) out.push(chunk.data);
        exitCode = chunk.exitCode;
      });
      call.on("error", reject);
      call.on("end", resolve);
    });

    call.write(ExecChunk.fromPartial({ vmId: "alpha", command: "cat", tty: false }));
    call.write(ExecChunk.fromPartial({ data: new TextEncoder().encode("hello"), stdin: true }));
    call.end(); // required now: nothing is sent until the whole request is buffered

    await done;
    expect(new TextDecoder().decode(out[0])).toBe("hello");
    expect(exitCode).toBe(0);
    expect(proxy.execCalls).toBe(1);
  });

  it("exec: a trailers-only NotFound rejection maps to NotFoundError", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const call = t.duplex<ExecChunk, ExecChunk>(BoxdApiDefinition.methods.exec);
    const err = await new Promise<unknown>((resolve) => {
      call.on("error", resolve);
      call.on("end", () => resolve(undefined));
      call.write(ExecChunk.fromPartial({ vmId: "does-not-exist", command: "echo hi" }));
      call.end();
    });
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain("VM not found");
  });

  it("exec: cancel() before end() never sends a request at all", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const call = t.duplex<ExecChunk, ExecChunk>(BoxdApiDefinition.methods.exec);
    let gotData = false;
    call.on("data", () => {
      gotData = true;
    });
    call.write(ExecChunk.fromPartial({ vmId: "alpha", command: "cat", tty: false }));
    call.cancel();
    call.end();
    await new Promise((r) => setTimeout(r, 100));
    expect(proxy.execCalls).toBe(0);
    expect(gotData).toBe(false);
  });

  it("uploadFileStream: a large upload (>4 MiB) streams as one multi-frame POST", async () => {
    proxy = startMockProxy();
    const t = transportAgainst(proxy);
    const data = new Uint8Array(5 * 1024 * 1024).fill(7);

    const resp = await new Promise<UploadFileResponse>((resolve, reject) => {
      const call = t.clientStream<UploadFileChunk, UploadFileResponse>(
        BoxdApiDefinition.methods.uploadFileStream,
        (err, r) => (err ? reject(err) : resolve(r)),
      );
      const CHUNK = 1024 * 1024;
      let offset = 0;
      let first = true;
      while (offset < data.length) {
        const slice = data.subarray(offset, offset + CHUNK);
        call.write(
          UploadFileChunk.fromPartial(
            first
              ? { vmId: "alpha", path: "/tmp/x", totalSize: data.length, data: slice }
              : { data: slice },
          ),
        );
        first = false;
        offset += slice.length;
      }
      call.end();
    });
    expect(resp.bytesWritten).toBe(data.length);
  });
});

describe("WebTransport: streamExec() is unavailable (needs a full-duplex transport)", () => {
  it("throws synchronously instead of hanging", () => {
    proxy = startMockProxy();
    const machines = new Machines(transportAgainst(proxy));
    expect(() => machines.streamExec("alpha", { command: "bash" })).toThrow(BoxdError);
    expect(() => machines.streamExec("alpha", { command: "bash" })).toThrow(/full-duplex/);
  });
});

describe("WebTransport end to end, through the real namespace classes (not the transport directly)", () => {
  it("machines.exec() round-trips through Machines, not just WebTransport.duplex()", async () => {
    proxy = startMockProxy();
    const machines = new Machines(transportAgainst(proxy));
    const result = await machines.exec("alpha", { command: "echo hi" });
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(proxy.execCalls).toBe(1);
  });

  it("fs: a trailers-only rejection's reason header becomes a FilesystemError", async () => {
    proxy = startMockProxy();
    const fs = new MachineFs(transportAgainst(proxy));
    const err = await fs.stat("alpha", "/missing").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("ENOENT");
    expect(err.path).toBe("/missing");
    expect(await fs.exists("alpha", "/missing")).toBe(false);
    await expect(fs.stat("alpha", "/outdated")).rejects.toBeInstanceOf(AgentOutdatedError);
  });

  it("fs: a reason in a unary call's trailer frame becomes a FilesystemError", async () => {
    proxy = startMockProxy();
    const err = await new MachineFs(transportAgainst(proxy)).mkdir("alpha", "/f").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EEXIST");
  });

  it("fs: read reassembles FsRead chunks and checks the end marker", async () => {
    proxy = startMockProxy();
    const data = await new MachineFs(transportAgainst(proxy)).read("alpha", "/etc/hostname");
    expect(new TextDecoder().decode(data)).toBe("contents of /etc/hostname");
  });

  it("fs: a read that fails part-way carries the trailer frame's reason", async () => {
    proxy = startMockProxy();
    const err = await new MachineFs(transportAgainst(proxy)).read("alpha", "/fails-midway").catch((e) => e);
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe("EIO");
  });

  it("fs: write streams a large file as one multi-frame FsWrite", async () => {
    proxy = startMockProxy();
    const data = new Uint8Array(3 * 1024 * 1024 + 1).fill(7);
    const entry = await new MachineFs(transportAgainst(proxy)).write("alpha", "/tmp/big", data);
    expect(entry.size).toBe(data.length);
    expect(entry.path).toBe("/tmp/big");
  });

  it("files.upload() round-trips through MachineFiles for a large file, not just clientStream()", async () => {
    proxy = startMockProxy();
    const files = new MachineFiles(transportAgainst(proxy));
    const data = new Uint8Array(5 * 1024 * 1024).fill(9);
    const written = await files.upload("alpha", "/tmp/big", data);
    expect(written).toBe(data.length);
  });
});
