/**
 * Computer use against a fake transport: what `machines.computer` puts on
 * the wire, and how the Claude and OpenAI adapters turn tool calls into
 * actions. The fake plays a 1600x900 screen and scales screenshots the way
 * the machine does, so the adapters' coordinate mapping is checked against
 * the sizes a real machine would report. The transports' handling of
 * `ComputerAction` is pinned in `computerTransport.test.ts` (grpc-js) and
 * `transportWeb.test.ts` (grpc-web).
 */
import { describe, expect, it } from "bun:test";
import {
  ComputerActionRequest,
  type ComputerActionResponse,
} from "../src/_generated/definitions.js";
import type { MethodDef, Transport, UnaryOptions } from "../src/_rpc.js";
import { fitWithin } from "../src/_computerScale.js";
import {
  APIConnectionError,
  APIStatusError,
  AuthenticationError,
  BoxdError,
  GrpcStatus,
  fromGrpcError,
} from "../src/errors.js";
import {
  CLAUDE_COMPUTER_TOOLSET,
  ClaudeComputer,
  MachineComputer,
  Machines,
  OpenAIComputer,
  PendingSafetyCheckError,
  type ClaudeComputerOptions,
  type ClaudeComputerToolResult,
  type OpenAIComputerOptions,
} from "../src/index.js";

// ── the fake ──────────────────────────────────────────────────────────────

interface Call {
  req: ComputerActionRequest;
  opts?: UnaryOptions;
}

/** The bytes of every fake screenshot. */
const PIXELS = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const PIXELS_B64 = btoa(String.fromCharCode(...PIXELS));

/**
 * A desktop of `width`x`height`. Answers every `ComputerAction` like the
 * machine: moves the pointer, and returns a screenshot (scaled to fit
 * `max_width`/`max_height`, of `region` when given) when asked. `fail`
 * answers the call with that index with an error instead.
 */
class FakeDesktop implements Transport {
  readonly calls: Call[] = [];
  readonly supportsInteractiveExec = true;
  cursor = { x: 10, y: 20 };
  fail = new Map<number, Error>();

  constructor(
    public width = 1600,
    public height = 900,
  ) {}

  async consoleOrigin(): Promise<string> {
    return "https://app.example.com";
  }

  async unary<Req, Resp>(method: MethodDef<Req, Resp>, req: Req, opts?: UnaryOptions): Promise<Resp> {
    expect(method.name).toBe("ComputerAction");
    // Round-trip through the codec, as a real transport does.
    const wire = ComputerActionRequest.decode(
      ComputerActionRequest.encode(req as ComputerActionRequest).finish(),
    );
    this.calls.push({ req: wire, opts });
    const failure = this.fail.get(this.calls.length - 1);
    if (failure) throw failure;
    const at = wire.mouseMove?.to ?? wire.click?.at ?? wire.mouseDown?.at ?? wire.mouseUp?.at ?? wire.scroll?.at;
    if (at) this.cursor = { x: at.x, y: at.y };
    if (wire.drag) this.cursor = { ...wire.drag.path[wire.drag.path.length - 1]! };
    const resp: ComputerActionResponse = {
      screenWidth: this.width,
      screenHeight: this.height,
      screenHeld: false,
      cursor: this.cursor,
    };
    if (wire.screenshot || wire.returnScreenshot) {
      const o = wire.screenshotOptions;
      const region = o?.region;
      const size = fitWithin(
        region?.width ?? this.width,
        region?.height ?? this.height,
        o?.maxWidth || Infinity,
        o?.maxHeight || Infinity,
      );
      const mime = o?.format === "jpeg" ? "image/jpeg" : o?.format === "webp" ? "image/webp" : "image/png";
      resp.screenshot = { data: PIXELS, mimeType: mime, width: size.width, height: size.height };
    }
    return resp as Resp;
  }

  serverStream(): never {
    throw new Error("not used");
  }
  duplex(): never {
    throw new Error("not used");
  }
  clientStream(): never {
    throw new Error("not used");
  }
  close(): void {}

  /** The requests' actions, without the machine or the screenshot fields. */
  get actions() {
    return this.calls.map(({ req }) => {
      const { vmId: _v, returnScreenshot: _r, screenshotOptions: _s, ...action } = req;
      return Object.fromEntries(Object.entries(action).filter(([, v]) => v !== undefined));
    });
  }

  /** Which calls took a screenshot. */
  get shots() {
    return this.calls.map(({ req }) => req.returnScreenshot);
  }
}

const statusError = (code: number, message: string) => fromGrpcError({ code, message, details: message });

const unreachable = () =>
  new APIConnectionError(
    "cannot connect to VM agent: agent at 10.42.0.7:57073 did not answer within 15s",
    GrpcStatus.UNAVAILABLE,
  );

// ── machines.computer ─────────────────────────────────────────────────────

describe("machines.computer", () => {
  it("is a namespace on machines, every call naming the machine", async () => {
    const t = new FakeDesktop();
    const machines = new Machines(t);
    expect(machines.computer).toBeInstanceOf(MachineComputer);
    await machines.computer.cursorPosition("my-vm");
    expect(t.calls[0]!.req.vmId).toBe("my-vm");
  });

  it("screenshot sends its options and maps the result", async () => {
    const t = new FakeDesktop();
    const r = await new MachineComputer(t).screenshot("m", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      region: { x: 10, y: 20, width: 300, height: 200 },
      delayMs: 250,
    });
    const { req, opts } = t.calls[0]!;
    expect(req.screenshot).toEqual({});
    expect(req.returnScreenshot).toBe(true);
    expect(req.screenshotOptions).toEqual({
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      region: { x: 10, y: 20, width: 300, height: 200 },
      delayMs: 250,
    });
    // A screenshot is safe to repeat; its delay extends the deadline.
    expect(opts).toEqual({ extraTimeoutMs: 250, retry: true });
    expect([r.screenWidth, r.screenHeight]).toEqual([1600, 900]);
    expect(r.cursor).toEqual({ x: 10, y: 20 });
    expect(r.screenshot.mimeType).toBe("image/jpeg");
    expect([r.screenshot.width, r.screenshot.height]).toEqual([300, 200]);
    expect(r.screenshot.data).toEqual(PIXELS);
    expect(r.screenshot.data).not.toBe(PIXELS); // a copy, not a view into the response
  });

  it("a plain screenshot sends empty defaults", async () => {
    const t = new FakeDesktop();
    const r = await new MachineComputer(t).screenshot("m");
    expect(t.calls[0]!.req.screenshotOptions).toEqual({
      format: "",
      quality: 0,
      maxWidth: 0,
      maxHeight: 0,
      region: undefined,
      delayMs: 0,
    });
    expect([r.screenshot.width, r.screenshot.height]).toEqual([1600, 900]);
  });

  it("puts every action on the wire", async () => {
    const t = new FakeDesktop();
    const c = new MachineComputer(t);
    await c.cursorPosition("m");
    await c.move("m", 100, 200);
    await c.click("m");
    await c.click("m", { x: 5, y: 6, button: "right", count: 2, modifiers: "ctrl+shift" });
    await c.click("m", { modifiers: ["ctrl", "alt"] });
    await c.mouseDown("m", { x: 1, y: 2 });
    await c.mouseUp("m", { button: "middle" });
    await c.drag("m", [{ x: 1, y: 1 }, { x: 50, y: 60 }, { x: 90, y: 99 }], { modifiers: "alt" });
    await c.scroll("m", { x: 300, y: 400, dy: 5 });
    await c.scroll("m", { dx: -2, modifiers: "shift" });
    await c.type("m", "hello world");
    await c.key("m", "ctrl+s", { repeat: 3 });
    await c.key("m", "shift", { holdMs: 1500 });
    await c.wait("m", 800);
    expect(t.actions).toEqual([
      { cursorPosition: {} },
      { mouseMove: { to: { x: 100, y: 200 } } },
      { click: { button: "", count: 0, modifiers: "" } },
      { click: { at: { x: 5, y: 6 }, button: "right", count: 2, modifiers: "ctrl+shift" } },
      { click: { button: "", count: 0, modifiers: "ctrl+alt" } },
      { mouseDown: { at: { x: 1, y: 2 }, button: "" } },
      { mouseUp: { button: "middle" } },
      {
        drag: {
          path: [{ x: 1, y: 1 }, { x: 50, y: 60 }, { x: 90, y: 99 }],
          button: "",
          modifiers: "alt",
        },
      },
      { scroll: { at: { x: 300, y: 400 }, deltaX: 0, deltaY: 5, modifiers: "" } },
      { scroll: { deltaX: -2, deltaY: 0, modifiers: "shift" } },
      { type: { text: "hello world" } },
      { key: { keys: "ctrl+s", repeat: 3, holdMs: 0 } },
      { key: { keys: "shift", repeat: 0, holdMs: 1500 } },
      { wait: { ms: 800 } },
    ]);
    expect(t.calls.every((c) => c.req.vmId === "m" && !c.req.returnScreenshot)).toBe(true);
  });

  it("lets the transport retry only reads and waits", async () => {
    const t = new FakeDesktop();
    const c = new MachineComputer(t);
    await c.cursorPosition("m");
    await c.wait("m", 10);
    await c.screenshot("m");
    await c.move("m", 1, 1);
    await c.click("m");
    await c.mouseDown("m");
    await c.mouseUp("m");
    await c.drag("m", [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    await c.scroll("m", { dy: 1 });
    await c.type("m", "x");
    await c.key("m", "a");
    expect(t.calls.map((c) => c.opts?.retry)).toEqual([
      true, true, true, false, false, false, false, false, false, false, false,
    ]);
  });

  it("sends an input action again only when it never reached the machine", async () => {
    const t = new FakeDesktop();
    t.fail.set(0, unreachable());
    const c = new MachineComputer(t);
    await c.click("m", { x: 1, y: 1 });
    expect(t.calls).toHaveLength(2);

    const t2 = new FakeDesktop();
    t2.fail.set(0, new APIConnectionError("the action failed inside the machine (exit 1)", GrpcStatus.UNAVAILABLE));
    await expect(new MachineComputer(t2).type("m", "x")).rejects.toThrow(/inside the machine/);
    expect(t2.calls).toHaveLength(1);
  });

  it("extends the deadline by the time the action itself takes", async () => {
    const t = new FakeDesktop();
    const c = new MachineComputer(t);
    await c.wait("m", 300_000);
    await c.key("m", "shift", { holdMs: 10_000 });
    await c.key("m", "Down", { repeat: 4 });
    // Every press counts: two combinations, twice.
    await c.key("m", "ctrl+a Delete", { repeat: 2 });
    await c.type("m", "x".repeat(100));
    await c.scroll("m", { dy: -10, dx: 2 });
    // Each segment of a drag is up to 20 small moves.
    await c.drag("m", [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]);
    await c.click("m", { screenshot: { delayMs: 500 } });
    expect(t.calls.map((c) => c.opts?.extraTimeoutMs)).toEqual([
      300_000, 10_040, 160, 160, 3_000, 360, 1_000, 500,
    ]);
  });

  it("takes a screenshot after an action in the same call when asked", async () => {
    const t = new FakeDesktop();
    const c = new MachineComputer(t);
    const r = await c.click("m", { x: 1, y: 2, screenshot: true });
    expect(t.calls[0]!.req.returnScreenshot).toBe(true);
    expect(t.calls[0]!.req.screenshotOptions?.format).toBe("");
    expect(r.screenshot?.width).toBe(1600);
    const r2 = await c.type("m", "hi", { screenshot: { format: "webp", maxWidth: 800 } });
    expect(t.calls[1]!.req.screenshotOptions).toMatchObject({ format: "webp", maxWidth: 800 });
    expect([r2.screenshot?.width, r2.screenshot?.height]).toEqual([800, 450]);
    const r3 = await c.move("m", 3, 4, { screenshot: false });
    expect(t.calls[2]!.req.returnScreenshot).toBe(false);
    expect(r3.screenshot).toBeUndefined();
    expect(r3.cursor).toEqual({ x: 3, y: 4 });
    const r4 = await c.cursorPosition("m", { screenshot: true });
    expect(r4.screenshot?.height).toBe(900);
  });

  it("rounds coordinates and refuses what can't go on the wire", async () => {
    const t = new FakeDesktop();
    const c = new MachineComputer(t);
    await c.move("m", 10.6, 20.4);
    expect(t.calls[0]!.req.mouseMove?.to).toEqual({ x: 11, y: 20 });
    await expect(c.click("m", { x: 5 })).rejects.toThrow(TypeError);
    await expect(c.move("m", Number.NaN, 1)).rejects.toThrow(TypeError);
    await expect(c.key("m", "a", { repeat: -1 })).rejects.toThrow(RangeError);
    await expect(c.wait("m", -5)).rejects.toThrow(RangeError);
    expect(t.calls).toHaveLength(1);
  });

  it("lets the server's errors through as they are", async () => {
    const t = new FakeDesktop();
    t.fail.set(0, statusError(GrpcStatus.INVALID_ARGUMENT, "coordinate (2000, 1) is off the screen"));
    const err = await new MachineComputer(t).move("m", 2000, 1).catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.grpcCode).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(err.message).toBe("coordinate (2000, 1) is off the screen");
  });

  it("a screenshot response without an image is an error", async () => {
    const t = new FakeDesktop();
    t.unary = (async () => ({ screenWidth: 1, screenHeight: 1, screenHeld: false, cursor: { x: 0, y: 0 } })) as Transport["unary"];
    await expect(new MachineComputer(t).screenshot("m")).rejects.toBeInstanceOf(BoxdError);
  });
});

// ── Claude ────────────────────────────────────────────────────────────────

let nextId = 0;
/** A computer action as Claude sends it. */
function use(name: string, input: Record<string, unknown> = {}) {
  return {
    type: "tool_use",
    id: `toolu_${++nextId}`,
    name,
    input,
    toolset_name: "computer",
    caller: { type: "direct" },
  };
}

const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";
const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: PIXELS_B64 } };

function claude(t: FakeDesktop, opts?: ClaudeComputerOptions) {
  return new ClaudeComputer(new Machines(t).computer, "m", { screenSize: null, ...opts });
}

describe("ClaudeComputer", () => {
  it("declares the toolset with no name or display size", () => {
    const cu = claude(new FakeDesktop());
    expect(cu.tool).toEqual({ type: "computer_toolset_20260801" });
    expect(CLAUDE_COMPUTER_TOOLSET).toBe("computer_toolset_20260801");
    expect(cu.machine).toBe("m");
  });

  it("takes a client or its machines.computer", async () => {
    const t = new FakeDesktop();
    await new ClaudeComputer(new MachineComputer(t), "other", { screenSize: null }).run([use("screenshot")]);
    await new ClaudeComputer({ machines: new Machines(t) }, "third", { screenSize: null }).run([use("screenshot")]);
    expect(t.calls.map((c) => c.req.vmId)).toEqual(["other", "third"]);
  });

  it("returns a screenshot scaled to fit 1280x800 as a base64 image", async () => {
    const t = new FakeDesktop();
    const shot = use("screenshot");
    expect(await claude(t).run([shot])).toEqual([
      { type: "tool_result", tool_use_id: shot.id, toolset_name: "computer", content: [IMAGE] },
    ]);
    expect(t.calls[0]!.req.screenshotOptions).toMatchObject({ maxWidth: 1280, maxHeight: 800, delayMs: 300 });
  });

  it("runs every member, mapping 1280x720 screenshot coordinates to the 1600x900 screen", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    const blocks = [
      use("screenshot"),
      use("left_click", { coordinate: [640, 360], text: "shift" }),
      use("right_click", { coordinate: [100, 100] }),
      use("middle_click"),
      use("double_click", { coordinate: [8, 8] }),
      use("triple_click", { coordinate: [400, 200], text: "ctrl+shift" }),
      use("left_click_drag", { start_coordinate: [100, 100], coordinate: [200, 50] }),
      use("mouse_move", { coordinate: [1279, 719] }),
      use("left_mouse_down"),
      use("left_mouse_up", { coordinate: [1279, 719] }),
      use("cursor_position"),
      use("scroll", { scroll_direction: "down", scroll_amount: 3, coordinate: [640, 360] }),
      use("scroll", { scroll_direction: "up", scroll_amount: 2 }),
      use("scroll", { scroll_direction: "left", scroll_amount: 4, text: "shift" }),
      use("scroll", { scroll_direction: "right", scroll_amount: 1 }),
      use("type", { text: "hello" }),
      use("key", { text: "ctrl+s" }),
      use("key", { text: "Down", repeat: 5 }),
      use("hold_key", { text: "shift", duration: 1.5 }),
      use("wait", { duration: 2 }),
      use("zoom", { region: [0, 0, 640, 360] }),
    ];
    const results = await cu.run(blocks);
    expect(results.map((r) => r.tool_use_id)).toEqual(blocks.map((b) => b.id));
    expect(results.every((r) => r.toolset_name === "computer" && r.is_error === undefined)).toBe(true);
    // The pointer ended at (1599, 899) on screen: (1279, 719) in the screenshot.
    expect(results[10]!.content).toBe("X=1279, Y=719");
    expect(results.filter((r) => r.content === "OK")).toHaveLength(18);

    expect(t.actions).toEqual([
      { screenshot: {} },
      { click: { at: { x: 800, y: 450 }, button: "left", count: 1, modifiers: "shift" } },
      { click: { at: { x: 125, y: 125 }, button: "right", count: 1, modifiers: "" } },
      { click: { button: "middle", count: 1, modifiers: "" } },
      { click: { at: { x: 10, y: 10 }, button: "left", count: 2, modifiers: "" } },
      { click: { at: { x: 500, y: 250 }, button: "left", count: 3, modifiers: "ctrl+shift" } },
      { drag: { path: [{ x: 125, y: 125 }, { x: 250, y: 63 }], button: "", modifiers: "" } },
      { mouseMove: { to: { x: 1599, y: 899 } } },
      { mouseDown: { button: "" } },
      { mouseUp: { at: { x: 1599, y: 899 }, button: "" } },
      { cursorPosition: {} },
      { scroll: { at: { x: 800, y: 450 }, deltaX: 0, deltaY: 3, modifiers: "" } },
      { scroll: { deltaX: 0, deltaY: -2, modifiers: "" } },
      { scroll: { deltaX: -4, deltaY: 0, modifiers: "shift" } },
      { scroll: { deltaX: 1, deltaY: 0, modifiers: "" } },
      { type: { text: "hello" } },
      { key: { keys: "ctrl+s", repeat: 0, holdMs: 0 } },
      { key: { keys: "Down", repeat: 5, holdMs: 0 } },
      { key: { keys: "shift", repeat: 0, holdMs: 1500 } },
      { wait: { ms: 2000 } },
      { screenshot: {} },
    ]);
    // The zoom reads that part of the screen, at full resolution, scaled to
    // fit the usual screenshot size.
    expect(t.calls[20]!.req.screenshotOptions).toMatchObject({
      region: { x: 0, y: 0, width: 800, height: 450 },
      maxWidth: 1280,
      maxHeight: 800,
    });
    expect(results[20]!.content).toEqual([IMAGE]);
  });

  it("a zoom doesn't change the scale of later coordinates", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    await cu.run([use("screenshot")]);
    // An 800x450 region fits 1280x800 unscaled: its image is 800x450, which
    // would read as a 0.5 scale if it were taken for a full screenshot.
    await cu.run([use("zoom", { region: [0, 0, 640, 360] }), use("left_click", { coordinate: [640, 360] })]);
    expect(t.calls[1]!.req.screenshotOptions?.region).toEqual({ x: 0, y: 0, width: 800, height: 450 });
    expect(t.calls[2]!.req.click?.at).toEqual({ x: 800, y: 450 });
  });

  it("takes the scale from the latest full screenshot", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    await cu.run([use("screenshot")]);
    // The screen shrinks to fit 1280x800 unscaled: from the next screenshot
    // on, coordinates map one to one.
    t.width = 1024;
    t.height = 768;
    await cu.run([use("left_click", { coordinate: [100, 100] })]);
    await cu.run([use("screenshot"), use("left_click", { coordinate: [100, 100] })]);
    expect(t.calls[1]!.req.click?.at).toEqual({ x: 125, y: 125 });
    expect(t.calls[3]!.req.click?.at).toEqual({ x: 100, y: 100 });
  });

  it("before any screenshot, scales from the screen's size", async () => {
    const t = new FakeDesktop();
    await claude(t).run([use("left_click", { coordinate: [640, 360] })]);
    expect(t.actions).toEqual([
      { cursorPosition: {} },
      { click: { at: { x: 800, y: 450 }, button: "left", count: 1, modifiers: "" } },
    ]);
  });

  it("answers only the computer toolset's blocks, in order", async () => {
    const t = new FakeDesktop();
    const a = use("left_click", { coordinate: [0, 0] });
    const b = use("type", { text: "x" });
    const results = await claude(t).run([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Clicking the field." },
      a,
      // A custom tool that happens to share a member's name.
      { type: "tool_use", id: "toolu_custom", name: "screenshot", input: {}, caller: { type: "direct" } },
      b,
    ]);
    expect(results.map((r) => r.tool_use_id)).toEqual([a.id, b.id]);
    expect(t.actions.map((a) => Object.keys(a)[0])).toEqual(["cursorPosition", "click", "type"]);
  });

  it("a screenshot right after an action rides on its call", async () => {
    const t = new FakeDesktop();
    const cu = claude(t, { format: "jpeg", quality: 60, settleMs: 500 });
    await cu.run([use("screenshot")]);
    const blocks = [
      use("left_click", { coordinate: [10, 10] }),
      use("screenshot"),
      use("type", { text: "hi" }),
      use("cursor_position"),
      use("screenshot"),
      use("zoom", { region: [0, 0, 10, 10] }),
      use("screenshot"),
    ];
    const results = await cu.run(blocks);
    const jpeg = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PIXELS_B64 } };
    expect(results.map((r) => r.content)).toEqual(["OK", [jpeg], "OK", "X=10, Y=10", [jpeg], [jpeg], [jpeg]]);
    expect(results.map((r) => r.tool_use_id)).toEqual(blocks.map((b) => b.id));
    // One call for the click and its screenshot, one for the cursor and its
    // screenshot; a zoom carries nothing.
    expect(t.actions.slice(1).map((a) => Object.keys(a)[0])).toEqual([
      "click", "type", "cursorPosition", "screenshot", "screenshot",
    ]);
    expect(t.shots.slice(1)).toEqual([true, false, true, true, true]);
    expect(t.calls[1]!.req.screenshotOptions).toMatchObject({ format: "jpeg", quality: 60, delayMs: 500 });
  });

  it("stops at the first failure and answers the rest with the halt text", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    await cu.run([use("screenshot")]);
    t.fail.set(2, statusError(GrpcStatus.INVALID_ARGUMENT, "unknown key name Foo"));
    const blocks = [
      use("left_click", { coordinate: [10, 10] }),
      use("key", { text: "Foo" }),
      use("type", { text: "never typed" }),
      use("screenshot"),
    ];
    const results = await cu.run(blocks);
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: blocks[0]!.id, toolset_name: "computer", content: "OK" },
      {
        type: "tool_result",
        tool_use_id: blocks[1]!.id,
        toolset_name: "computer",
        is_error: true,
        content: "unknown key name Foo",
      },
      { type: "tool_result", tool_use_id: blocks[2]!.id, toolset_name: "computer", is_error: true, content: NOT_EXECUTED },
      { type: "tool_result", tool_use_id: blocks[3]!.id, toolset_name: "computer", is_error: true, content: NOT_EXECUTED },
    ]);
    expect(t.calls).toHaveLength(3);
  });

  it("an action that fails takes its screenshot down with it", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    await cu.run([use("screenshot")]);
    t.fail.set(1, statusError(GrpcStatus.INVALID_ARGUMENT, "type needs text"));
    const results = await cu.run([use("type", { text: "" }), use("screenshot")]);
    expect(results.map((r) => [r.is_error, r.content])).toEqual([
      [true, "type needs text"],
      [true, NOT_EXECUTED],
    ]);
  });

  it("reports input it can't use, and members it doesn't know, as failures", async () => {
    const t = new FakeDesktop();
    const cu = claude(t);
    await cu.run([use("screenshot")]);
    const cases: [ReturnType<typeof use>, RegExp][] = [
      [use("mouse_move", {}), /coordinate must be \[x, y\]/],
      [use("left_click", { coordinate: [1, "2"] }), /coordinate must be \[x, y\]/],
      [use("left_click_drag", { coordinate: [1, 2] }), /start_coordinate must be \[x, y\]/],
      [use("zoom", { region: [0, 0, 10] }), /region must be \[x0, y0, x1, y1\]/],
      [use("scroll", { scroll_direction: "sideways", scroll_amount: 1 }), /scroll_direction must be/],
      [use("scroll", { scroll_direction: "up" }), /scroll_amount must be a number/],
      [use("scroll", { scroll_direction: "up", scroll_amount: -3 }), /scroll_amount must be a whole number/],
      [use("scroll", { scroll_direction: "up", scroll_amount: 1.5 }), /scroll_amount must be a whole number/],
      [use("type", {}), /text must be a string/],
      [use("wait", { duration: -1 }), /duration must not be negative/],
      [use("open_app", {}), /unknown computer action "open_app"/],
    ];
    for (const [block, message] of cases) {
      const [result] = await cu.run([block]);
      expect(result!.is_error).toBe(true);
      expect(result!.content).toMatch(message);
    }
    expect(t.calls).toHaveLength(1);
  });

  it("throws errors about the credentials or the machine instead of reporting them", async () => {
    const t = new FakeDesktop();
    t.fail.set(0, new AuthenticationError("token expired"));
    await expect(claude(t).run([use("screenshot"), use("type", { text: "x" })])).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    const t2 = new FakeDesktop();
    t2.fail.set(0, statusError(GrpcStatus.NOT_FOUND, "VM not found"));
    await expect(claude(t2).run([use("screenshot")])).rejects.toThrow("VM not found");
  });

  it("refuses a screenshot size outside Claude's image limits", () => {
    const t = new FakeDesktop();
    expect(() => claude(t, { maxWidth: 3000, maxHeight: 800 })).toThrow(RangeError);
    expect(() => claude(t, { maxWidth: 2576, maxHeight: 2576 })).toThrow(/4784/);
    expect(() => claude(t, { maxWidth: 0 })).toThrow(RangeError);
    expect(() => claude(t, { maxWidth: 1920, maxHeight: 1080 })).not.toThrow();
    expect(() => claude(t, { maxWidth: 2576, maxHeight: 1449 })).not.toThrow();
  });

  it("returns results the Anthropic SDK accepts as a user message's content", () => {
    // Type-level: a ClaudeComputerToolResult is a ToolResultBlockParam.
    const r: ClaudeComputerToolResult = { type: "tool_result", tool_use_id: "x", toolset_name: "computer", content: "OK" };
    expect(r.toolset_name).toBe("computer");
  });
});

// ── OpenAI ────────────────────────────────────────────────────────────────

/** 1600x900 shown at 1280x720. */
const SCALED: OpenAIComputerOptions = { maxWidth: 1280, maxHeight: 800 };

function openai(t: FakeDesktop, opts: OpenAIComputerOptions = SCALED) {
  return new OpenAIComputer({ machines: new Machines(t) }, "m", { screenSize: null, ...opts });
}

const call = (callId: string, actions: object[], extra: object = {}) => ({
  type: "computer_call",
  call_id: callId,
  actions,
  status: "completed",
  ...extra,
});

describe("OpenAIComputer", () => {
  it("declares the computer tool, and the preview tool at the screenshot size", async () => {
    const t = new FakeDesktop();
    expect(openai(t).tool).toEqual({ type: "computer" });
    expect(await openai(t).previewTool()).toEqual({
      type: "computer_use_preview",
      display_width: 1280,
      display_height: 720,
      environment: "linux",
    });
    // The default size fits this screen unscaled.
    expect(await new OpenAIComputer(new Machines(t).computer, "m", { screenSize: null }).previewTool()).toMatchObject({
      display_width: 1600,
      display_height: 900,
    });
  });

  it("runs a batch in order and answers with one screenshot taken with the last action", async () => {
    const t = new FakeDesktop();
    const out = await openai(t).run([
      { type: "reasoning" },
      call("call_1", [
        { type: "screenshot" },
        { type: "click", button: "left", x: 640, y: 360 },
        { type: "click", button: "right", x: 100, y: 100, keys: ["CTRL", "SHIFT"] },
        { type: "click", button: "wheel", x: 0, y: 0 },
        { type: "click", button: "back", x: 0, y: 0 },
        { type: "click", button: "forward", x: 0, y: 0 },
        { type: "double_click", x: 8, y: 8, keys: null },
        { type: "drag", path: [{ x: 100, y: 100 }, { x: 150, y: 120 }, { x: 200, y: 50 }] },
        { type: "move", x: 1279, y: 719 },
        { type: "scroll", x: 640, y: 360, scroll_x: 0, scroll_y: 120 },
        { type: "scroll", x: 640, y: 360, scroll_x: -10, scroll_y: 0, keys: ["SHIFT"] },
        { type: "scroll", x: 640, y: 360, scroll_x: 0, scroll_y: 0 },
        { type: "scroll", x: 640, y: 360, scroll_x: 0, scroll_y: 99999 },
        { type: "keypress", keys: ["CTRL", "A"] },
        { type: "keypress", keys: ["ENTER"] },
        { type: "keypress", keys: ["ARROWLEFT"] },
        { type: "keypress", keys: [" "] },
        { type: "type", text: "hello" },
        { type: "wait", ms: 500 },
        { type: "wait" },
        { type: "screenshot" },
      ]),
    ]);
    expect(t.actions).toEqual([
      // No screenshot seen yet: the screen's size sets the scale.
      { cursorPosition: {} },
      { click: { at: { x: 800, y: 450 }, button: "left", count: 1, modifiers: "" } },
      { click: { at: { x: 125, y: 125 }, button: "right", count: 1, modifiers: "CTRL+SHIFT" } },
      { click: { at: { x: 0, y: 0 }, button: "middle", count: 1, modifiers: "" } },
      { click: { at: { x: 0, y: 0 }, button: "back", count: 1, modifiers: "" } },
      { click: { at: { x: 0, y: 0 }, button: "forward", count: 1, modifiers: "" } },
      { click: { at: { x: 10, y: 10 }, button: "left", count: 2, modifiers: "" } },
      { drag: { path: [{ x: 125, y: 125 }, { x: 188, y: 150 }, { x: 250, y: 63 }], button: "", modifiers: "" } },
      { mouseMove: { to: { x: 1599, y: 899 } } },
      { scroll: { at: { x: 800, y: 450 }, deltaX: 0, deltaY: 1, modifiers: "" } },
      { scroll: { at: { x: 800, y: 450 }, deltaX: -1, deltaY: 0, modifiers: "SHIFT" } },
      // A scroll of nothing still moves the pointer there.
      { mouseMove: { to: { x: 800, y: 450 } } },
      { scroll: { at: { x: 800, y: 450 }, deltaX: 0, deltaY: 100, modifiers: "" } },
      { key: { keys: "CTRL+a", repeat: 0, holdMs: 0 } },
      { key: { keys: "ENTER", repeat: 0, holdMs: 0 } },
      { key: { keys: "ARROWLEFT", repeat: 0, holdMs: 0 } },
      { key: { keys: "space", repeat: 0, holdMs: 0 } },
      { type: { text: "hello" } },
      { wait: { ms: 500 } },
      { wait: { ms: 2000 } },
    ]);
    // Only the last action that isn't a screenshot takes one, after a settle delay.
    expect(t.shots.filter(Boolean)).toHaveLength(1);
    expect(t.calls.at(-1)!.req.returnScreenshot).toBe(true);
    expect(t.calls.at(-1)!.req.screenshotOptions).toMatchObject({ maxWidth: 1280, maxHeight: 800, delayMs: 300 });
    expect(out).toEqual([
      {
        type: "computer_call_output",
        call_id: "call_1",
        output: { type: "computer_screenshot", image_url: `data:image/png;base64,${PIXELS_B64}`, detail: "original" },
      },
    ]);
  });

  it("answers every computer_call of a response, and takes the response itself", async () => {
    const t = new FakeDesktop();
    const out = await openai(t).run({
      output: [call("a", [{ type: "screenshot" }]), { type: "message" }, call("b", [{ type: "screenshot" }])],
    });
    expect(out.map((o) => o.call_id)).toEqual(["a", "b"]);
    expect(t.actions).toEqual([{ screenshot: {} }, { screenshot: {} }]);
    expect(await openai(t).run([{ type: "message" }])).toEqual([]);
  });

  it("runs the preview tool's single action, and takes a screenshot after a no-op", async () => {
    const t = new FakeDesktop();
    const cu = openai(t, { ...SCALED, format: "jpeg", scrollPixelsPerClick: 100, waitMs: 2500 });
    const single = (id: string, action: object) => ({ type: "computer_call", call_id: id, action });
    await cu.run([single("a", { type: "screenshot" })]);
    const [out] = await cu.run([single("b", { type: "scroll", x: 1, y: 1, scroll_x: 0, scroll_y: 450 })]);
    await cu.run([single("c", { type: "wait" })]);
    expect(t.actions).toEqual([
      { screenshot: {} },
      { scroll: { at: { x: 1, y: 1 }, deltaX: 0, deltaY: 5, modifiers: "" } },
      { wait: { ms: 2500 } },
    ]);
    // The preview tool's output carries no `detail`.
    expect(out!.output).toEqual({ type: "computer_screenshot", image_url: `data:image/jpeg;base64,${PIXELS_B64}` });
  });

  it("maps coordinates with the scale of the screenshot the model saw", async () => {
    const t = new FakeDesktop();
    const cu = openai(t);
    await cu.run([call("a", [{ type: "screenshot" }])]);
    t.width = 1024;
    t.height = 768;
    // The model still sees the 1280x720 screenshot until the next one.
    await cu.run([call("b", [{ type: "move", x: 100, y: 100 }])]);
    await cu.run([call("c", [{ type: "move", x: 100, y: 100 }])]);
    expect(t.calls[1]!.req.mouseMove?.to).toEqual({ x: 125, y: 125 });
    expect(t.calls[2]!.req.mouseMove?.to).toEqual({ x: 100, y: 100 });
  });

  it("stops at a failed action and throws", async () => {
    const t = new FakeDesktop();
    const cu = openai(t);
    await cu.run([call("a", [{ type: "screenshot" }])]);
    t.fail.set(2, statusError(GrpcStatus.INVALID_ARGUMENT, "No such key name 'HYPER'"));
    const err = await cu
      .run([
        call("b", [
          { type: "click", button: "left", x: 1, y: 1 },
          { type: "keypress", keys: ["HYPER"] },
          { type: "type", text: "never" },
        ]),
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(t.calls).toHaveLength(3);
    await expect(cu.run([call("c", [{ type: "click", button: "middle", x: 1, y: 1 }])])).rejects.toThrow(
      /unknown mouse button/,
    );
    await expect(cu.run([call("d", [{ type: "teleport" }])])).rejects.toThrow(/unknown computer action/);
  });

  it("won't act on pending safety checks unless they are acknowledged", async () => {
    const checks = [{ id: "sc_1", code: "malicious_instructions", message: "Check the page first." }];
    const withChecks = [call("c", [{ type: "click", button: "left", x: 1, y: 1 }], { pending_safety_checks: checks })];

    const t = new FakeDesktop();
    const err = await openai(t).run(withChecks).catch((e) => e);
    expect(err).toBeInstanceOf(PendingSafetyCheckError);
    expect(err).toBeInstanceOf(BoxdError);
    expect(err.callId).toBe("c");
    expect(err.checks).toEqual(checks);
    expect(err.message).toMatch(/Check the page first/);
    await expect(openai(t).run(withChecks, { acknowledgeSafetyChecks: () => false })).rejects.toBeInstanceOf(
      PendingSafetyCheckError,
    );
    expect(t.calls).toHaveLength(0);

    const seen: unknown[] = [];
    const [out] = await openai(t).run(withChecks, {
      acknowledgeSafetyChecks: async (c) => {
        seen.push(c);
        return true;
      },
    });
    expect(seen).toEqual([checks]);
    expect(out!.acknowledged_safety_checks).toEqual(checks);
    const [out2] = await openai(t).run(withChecks, { acknowledgeSafetyChecks: true });
    expect(out2!.acknowledged_safety_checks).toEqual(checks);
  });
});

describe("holding the screen", () => {
  const kinds = (t: FakeDesktop) =>
    t.calls.map((c) => (c.req.setScreenSize ? "setScreenSize" : c.req.screenshot ? "screenshot" : "other"));

  it("holds once, before the first action", async () => {
    const t = new FakeDesktop();
    const computer = new ClaudeComputer(new Machines(t).computer, "m");
    await computer.run([use("screenshot")]);
    await computer.run([use("screenshot")]);
    expect(kinds(t)).toEqual(["setScreenSize", "screenshot", "screenshot"]);
    expect(t.calls[0]!.req.setScreenSize).toEqual({ width: 1280, height: 800 });
  });

  it("holds nothing for a turn without computer actions", async () => {
    const t = new FakeDesktop();
    await new ClaudeComputer(new Machines(t).computer, "m").run([{ type: "text" }]);
    await new OpenAIComputer(new Machines(t).computer, "m").run([{ type: "message" }]);
    expect(t.calls).toEqual([]);
  });

  it("takes another size, or leaves the screen alone", async () => {
    let t = new FakeDesktop();
    await new ClaudeComputer(new Machines(t).computer, "m", {
      screenSize: { width: 1024, height: 768 },
    }).run([use("screenshot")]);
    expect(t.calls[0]!.req.setScreenSize).toEqual({ width: 1024, height: 768 });
    t = new FakeDesktop();
    await new ClaudeComputer(new Machines(t).computer, "m", { screenSize: null }).run([use("screenshot")]);
    expect(kinds(t)).toEqual(["screenshot"]);
  });

  it("release lets go, and the next action holds again", async () => {
    const t = new FakeDesktop();
    const computer = new ClaudeComputer(new Machines(t).computer, "m");
    await computer.run([use("screenshot")]);
    await computer.release();
    expect(t.calls.at(-1)!.req.setScreenSize).toEqual({ width: 0, height: 0 });
    await computer.run([use("screenshot")]);
    expect(kinds(t).slice(-2)).toEqual(["setScreenSize", "screenshot"]);
  });

  it("OpenAI doesn't hold for a call it refuses", async () => {
    const t = new FakeDesktop();
    const computer = new OpenAIComputer(new Machines(t).computer, "m");
    const refused = call("c1", [{ type: "move", x: 1, y: 1 }], {
      pending_safety_checks: [{ id: "s", code: "x", message: "careful" }],
    });
    await computer.run([refused]).catch(() => {});
    expect(t.calls).toEqual([]);
    await computer.run([call("c2", [{ type: "move", x: 1, y: 1 }])]);
    expect(kinds(t)[0]).toBe("setScreenSize");
  });

  it("setScreenSize answers whether the screen is held", async () => {
    const t = new FakeDesktop();
    t.unary = (async () => ({ screenWidth: 1280, screenHeight: 800, screenHeld: true, cursor: { x: 0, y: 0 } })) as never;
    const r = await new MachineComputer(t).setScreenSize("m", 1280, 800);
    expect(r.screenHeld).toBe(true);
  });
});

describe("regions", () => {
  it("a call names its region", async () => {
    const t = new FakeDesktop();
    const computer = new Machines(t).computer;
    await computer.click("m", { x: 1, y: 2, region: "nyc" });
    // A screenshot's own `region` is the part of the screen to capture.
    await computer.inRegion("nyc").screenshot("m", { region: { x: 1, y: 2, width: 3, height: 4 } });
    expect(t.calls.map((c) => c.opts?.region)).toEqual(["nyc", "nyc"]);
    expect(t.calls[1]!.req.screenshotOptions?.region?.width).toBe(3);
    // The timeout and retry settings still reach the transport.
    expect(t.calls[0]!.opts?.retry).toBe(false);
  });

  it("a namespace bound to a region, and a call that names another", async () => {
    const t = new FakeDesktop();
    const bound = new Machines(t).computer.inRegion("nyc");
    await bound.click("m", { x: 1, y: 2 });
    await bound.click("m", { x: 1, y: 2, region: "fra" });
    await new Machines(t).computer.click("m", { x: 1, y: 2 });
    expect(t.calls.map((c) => c.opts?.region)).toEqual(["nyc", "fra", undefined]);
  });

  it("an adapter works in the machine's region", async () => {
    const t = new FakeDesktop();
    const computer = new ClaudeComputer(new Machines(t).computer, "m", { region: "nyc" });
    await computer.run([use("screenshot")]);
    expect(new Set(t.calls.map((c) => c.opts?.region))).toEqual(new Set(["nyc"]));
  });
});
