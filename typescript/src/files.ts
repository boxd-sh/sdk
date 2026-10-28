import type { Transport } from "./_rpc.js";
import { BoxdError } from "./errors.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import type {
  DownloadFileChunk,
  DownloadFileRequest,
  UploadFileChunk,
  UploadFileResponse,
} from "./_generated/definitions.js";
import type { Platform } from "./_platform.js";
import { toDirListing, type DirListing } from "./models.js";

/**
 * gRPC's default max message is 4 MiB. Stay under it with room for framing;
 * anything bigger goes through `UploadFileStream`, which exists for exactly
 * this reason.
 */
const SINGLE_MESSAGE_LIMIT = 3 * 1024 * 1024;
/** Chunk size on the streaming path. */
const CHUNK_SIZE = 1024 * 1024;

export type UploadSource = string | Uint8Array | { fromPath: string };

/**
 * Files on a machine. `machine cp` is one CLI verb; here it is two directions,
 * because upload and download have nothing in common but a path.
 */
export class MachineFiles {
  constructor(
    private readonly transport: Transport,
    private readonly platform: Platform = {},
  ) {}

  /** Write a file into the machine. Returns the byte count the server confirmed. */
  async upload(id: string, path: string, source: UploadSource): Promise<number> {
    const data = await toBytes(source, this.platform);
    if (data.length <= SINGLE_MESSAGE_LIMIT) {
      const resp = await this.transport.unary(BoxdApiDefinition.methods.uploadFile, {
        vmId: id,
        path,
        data,
      });
      // Older servers don't verify and leave this 0 — fall back to what we sent.
      return resp.bytesWritten || data.length;
    }
    return this.#uploadStream(id, path, data);
  }

  /**
   * Read a file out of the machine. Streams (`DownloadFileStream`), so there is
   * no size cap — the whole file still lands in memory as one `Uint8Array`.
   */
  async download(id: string, path: string): Promise<Uint8Array> {
    const req: DownloadFileRequest = { vmId: id, path };
    return new Promise<Uint8Array>((resolve, reject) => {
      const parts: Uint8Array[] = [];
      let received = 0;
      let total: number | undefined;
      const call = this.transport.serverStream(BoxdApiDefinition.methods.downloadFileStream, req);
      call.on("data", (chunk: DownloadFileChunk) => {
        if (chunk.totalSize) total = Number(chunk.totalSize);
        if (chunk.data && chunk.data.length > 0) {
          parts.push(chunk.data);
          received += chunk.data.length;
        }
      });
      // Already a `BoxdError` — both transports normalize errors before
      // emitting them, so this file never touches `fromGrpcError` itself.
      call.on("error", (err: unknown) => reject(err));
      call.on("end", () => {
        if (total !== undefined && received !== total) {
          reject(new BoxdError(`download truncated: expected ${total} bytes, got ${received}`));
          return;
        }
        resolve(concat(parts, received));
      });
    });
  }

  /**
   * The first chunk carries vm_id/path/total_size; the rest carry bytes only.
   * The server reads exactly total_size bytes and stats the result.
   */
  async #uploadStream(id: string, path: string, data: Uint8Array): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const call = this.transport.clientStream(
        BoxdApiDefinition.methods.uploadFileStream,
        (err: unknown, resp: UploadFileResponse) => {
          if (err) return reject(err);
          resolve(resp.bytesWritten || data.length);
        },
      );
      let offset = 0;
      let first = true;
      while (offset < data.length) {
        const slice = data.subarray(offset, offset + CHUNK_SIZE);
        const chunk: UploadFileChunk = first
          ? { vmId: id, path, totalSize: data.length, data: slice }
          : { vmId: "", path: "", totalSize: 0, data: slice };
        call.write(chunk);
        first = false;
        offset += slice.length;
      }
      call.end();
    });
  }

  /**
   * Immediate (non-recursive) contents of a directory inside the machine. A
   * directory bigger than the server's per-listing cap comes back with
   * `truncated: true` and only the first slice of its entries (in no
   * particular order); use `exec` for an exhaustive listing.
   */
  async listDir(id: string, path: string): Promise<DirListing> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listDir, { vmId: id, path });
    return toDirListing(resp);
  }

  /** Create a directory. The parent must already exist. */
  async mkdir(id: string, path: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.mkdir, { vmId: id, path });
  }

  /** Move/rename a file or directory. */
  async rename(id: string, oldPath: string, newPath: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.renamePath, { vmId: id, oldPath, newPath });
  }

  /** Remove a file, or a directory and everything under it. */
  async delete(id: string, path: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deletePath, { vmId: id, path });
  }

  /** Copy a file, or a directory recursively. */
  async copy(id: string, oldPath: string, newPath: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.copyPath, { vmId: id, oldPath, newPath });
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function toBytes(source: UploadSource, platform: Platform): Promise<Uint8Array> {
  if (typeof source === "string") return new TextEncoder().encode(source);
  if (source instanceof Uint8Array) return source;
  if (source && typeof source === "object" && "fromPath" in source) {
    if (!platform.readFile) {
      throw new BoxdError(
        "upload: { fromPath } reads a local file, which the web entry (@boxd-sh/sdk/web) " +
          "can't do. Pass the contents as a string or Uint8Array, or use the Node entry " +
          "(@boxd-sh/sdk).",
      );
    }
    return platform.readFile(source.fromPath);
  }
  throw new TypeError("upload: expected a string, Uint8Array, or { fromPath }");
}
