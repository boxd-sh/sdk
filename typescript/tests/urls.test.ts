import { describe, expect, it } from "bun:test";
import { deriveExchangeUrl, parseSize, resolveEndpoint } from "../src/utils.js";

describe("parseSize", () => {
  it("empty → 0", () => expect(parseSize("")).toBe(0));
  it("plain int", () => expect(parseSize("1024")).toBe(1024));
  it("K suffix", () => expect(parseSize("1K")).toBe(1024));
  it("M suffix", () => expect(parseSize("1M")).toBe(1024 * 1024));
  it("G suffix", () => expect(parseSize("8G")).toBe(8 * 1024 ** 3));
  it("T suffix", () => expect(parseSize("1T")).toBe(1024 ** 4));
  it("lowercase", () => expect(parseSize("512m")).toBe(512 * 1024 ** 2));
  it("GiB form", () => expect(parseSize("4GiB")).toBe(4 * 1024 ** 3));
  it("GB form", () => expect(parseSize("8GB")).toBe(8 * 1024 ** 3));
  it("invalid throws", () => expect(() => parseSize("abc")).toThrow());
});

describe("resolveEndpoint", () => {
  it("http:// → plaintext, scheme stripped", () =>
    expect(resolveEndpoint("http://boxd.sh:9443")).toEqual({
      host: "boxd.sh:9443",
      useTls: false,
    }));
  it("https:// → TLS, scheme stripped", () =>
    expect(resolveEndpoint("https://grpc.boxd.sh:443")).toEqual({
      host: "grpc.boxd.sh:443",
      useTls: true,
    }));
  it("bare localhost → plaintext", () =>
    expect(resolveEndpoint("localhost:9443")).toEqual({
      host: "localhost:9443",
      useTls: false,
    }));
  it("bare 127.* → plaintext", () =>
    expect(resolveEndpoint("127.0.0.1:9443")).toEqual({
      host: "127.0.0.1:9443",
      useTls: false,
    }));
  it("bare non-local → TLS (safe default)", () =>
    expect(resolveEndpoint("grpc.boxd.sh:443")).toEqual({
      host: "grpc.boxd.sh:443",
      useTls: true,
    }));
  it("explicit scheme always wins", () => {
    expect(resolveEndpoint("http://localhost:9443").useTls).toBe(false);
    expect(resolveEndpoint("https://localhost:443").useTls).toBe(true);
  });
});

describe("deriveExchangeUrl", () => {
  const PATH = "/api/v1/auth/token";

  it("production default", () =>
    expect(deriveExchangeUrl("http://boxd.sh:9443")).toBe(`https://app.boxd.sh${PATH}`));

  it("any other cluster follows from its baseURL", () => {
    expect(deriveExchangeUrl("http://staging.example.com:9443")).toBe(
      `https://app.staging.example.com${PATH}`,
    );
    expect(deriveExchangeUrl("http://boxd.sh:9443")).toBe(
      `https://app.boxd.sh${PATH}`,
    );
  });

  it("forces https and drops the API port", () =>
    // The API port is not the console's port; carrying it over would 404.
    expect(deriveExchangeUrl("http://dev.example.com:9443")).toBe(
      `https://app.dev.example.com${PATH}`,
    ));

  it("drops a path and a trailing slash", () => {
    expect(deriveExchangeUrl("https://boxd.sh/")).toBe(`https://app.boxd.sh${PATH}`);
    expect(deriveExchangeUrl("https://boxd.sh/some/prefix")).toBe(
      `https://app.boxd.sh${PATH}`,
    );
  });

  it("localhost carve-out: same host, port kept, scheme kept", () => {
    expect(deriveExchangeUrl("http://localhost:8080")).toBe(`http://localhost:8080${PATH}`);
    expect(deriveExchangeUrl("localhost:8080")).toBe(`http://localhost:8080${PATH}`);
  });

  it("raw-IP carve-out: never gets an app. prefix", () => {
    expect(deriveExchangeUrl("https://10.0.0.5")).toBe(`https://10.0.0.5${PATH}`);
    expect(deriveExchangeUrl("http://10.0.0.5:9443")).toBe(`http://10.0.0.5:9443${PATH}`);
    expect(deriveExchangeUrl("http://127.0.0.1:9443")).toBe(`http://127.0.0.1:9443${PATH}`);
  });

  it("an already-app. host is left alone", () =>
    expect(deriveExchangeUrl("https://app.boxd.sh")).toBe(`https://app.boxd.sh${PATH}`));

  it("a host that merely starts with digits is not an IP", () =>
    expect(deriveExchangeUrl("https://1boxd.sh")).toBe(`https://app.1boxd.sh${PATH}`));
});
