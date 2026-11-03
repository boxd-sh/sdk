import type { Transport } from "./_rpc.js";
import {
  BoxdApiDefinition,
  type ComputerActionRequest,
  type ComputerActionResponse,
  type ComputerPoint as WirePoint,
  type ComputerScreenshotOptions as WireScreenshotOptions,
} from "./_generated/definitions.js";
import { APIConnectionError, BoxdError, agentUnreachable } from "./errors.js";
import type { RegionOption } from "./regions.js";

/** A point on the screen, in pixels from the top left. */
export interface ComputerPoint {
  x: number;
  y: number;
}

/** A rectangle on the screen, in pixels. */
export interface ComputerRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerButton = "left" | "right" | "middle" | "back" | "forward";

export type ComputerImageFormat = "png" | "jpeg" | "webp";

export interface ComputerScreenshotOptions {
  /** `"png"` (the default), `"jpeg"` or `"webp"`. */
  format?: ComputerImageFormat;
  /** JPEG and WebP quality, 1-100. Default 80. */
  quality?: number;
  /** Scale the image down to fit within this width, keeping its shape.
   *  Never scaled up. Default: no limit. */
  maxWidth?: number;
  /** Scale the image down to fit within this height, keeping its shape.
   *  Never scaled up. Default: no limit. */
  maxHeight?: number;
  /** Only this part of the screen, in screen pixels, at full resolution
   *  (then scaled to fit `maxWidth`/`maxHeight`): for zooming in. */
  region?: ComputerRegion;
  /** Wait this long after the action before taking the screenshot, so the
   *  screen can catch up. Up to 60000. */
  delayMs?: number;
}

export interface ComputerActionOptions extends RegionOption {
  /** Take a screenshot after the action and return it with the result:
   *  `true`, or how to take it. One round trip does both. */
  screenshot?: boolean | ComputerScreenshotOptions;
}

export interface ComputerClickOptions extends ComputerActionOptions {
  /** Where to click, in screen pixels. Give both or neither: without them
   *  the click lands where the pointer is. */
  x?: number;
  y?: number;
  /** Default `"left"`. */
  button?: ComputerButton;
  /** 1 (the default), 2 for a double click, 3 for a triple click. */
  count?: number;
  /** Keys held down during the click: `"shift"`, `"ctrl"`, `"alt"`,
   *  `"super"`, or several joined with `"+"` (`"ctrl+shift"`) or listed. */
  modifiers?: string | readonly string[];
}

export interface ComputerMouseButtonOptions extends ComputerActionOptions {
  /** Where to press or release, in screen pixels. Give both or neither:
   *  without them it happens where the pointer is. */
  x?: number;
  y?: number;
  /** Default `"left"`. */
  button?: ComputerButton;
}

export interface ComputerDragOptions extends ComputerActionOptions {
  /** Default `"left"`. */
  button?: ComputerButton;
  /** Keys held down during the drag, as for {@link ComputerClickOptions.modifiers}. */
  modifiers?: string | readonly string[];
}

export interface ComputerScrollOptions extends ComputerActionOptions {
  /** Where to scroll, in screen pixels. Give both or neither: without them
   *  it scrolls where the pointer is. */
  x?: number;
  y?: number;
  /** Wheel clicks sideways; positive scrolls right. */
  dx?: number;
  /** Wheel clicks up or down; positive scrolls down. */
  dy?: number;
  /** Keys held down while scrolling, as for {@link ComputerClickOptions.modifiers}. */
  modifiers?: string | readonly string[];
}

export interface ComputerKeyOptions extends ComputerActionOptions {
  /** Press the keys this many times. Default once. */
  repeat?: number;
  /** Hold one key or combination down this long, then release it, instead
   *  of pressing it. Up to 300000 (5 minutes). */
  holdMs?: number;
}

/** A screenshot, encoded. */
export interface ComputerScreenshot {
  data: Uint8Array;
  /** `"image/png"`, `"image/jpeg"` or `"image/webp"`. */
  mimeType: string;
  /** The image's size, after any scaling: smaller than the screen when it
   *  was scaled down. */
  width: number;
  height: number;
}

/** The desktop after an action. */
export interface ComputerActionResult {
  /** The screen's size, in pixels. */
  screenWidth: number;
  screenHeight: number;
  /** {@link MachineComputer.setScreenSize} is holding the screen at this
   *  size: someone watching in the console sees it scaled to fit instead of
   *  resizing it. */
  screenHeld: boolean;
  /** Where the pointer is after the action, in screen pixels. */
  cursor: ComputerPoint;
  /** Set when one was asked for. */
  screenshot?: ComputerScreenshot;
}

/** What {@link MachineComputer.screenshot} returns: always with a screenshot. */
export interface ComputerScreenshotResult extends ComputerActionResult {
  screenshot: ComputerScreenshot;
}

/** Waits before sending a mouse or keyboard action again, after the server
 *  couldn't reach the machine's agent (so the action never ran). */
const RETRY_BACKOFF_MS = [1_000, 3_000];

/**
 * `boxd.machines.computer`: a machine's desktop, for computer-use agents:
 * screenshots, the mouse and the keyboard. It is the desktop the console's
 * Desktop view shows, started on demand.
 *
 * Every method takes the machine (name or id) first and does one action.
 * Coordinates are screen pixels from the top left. Any action can also take
 * a screenshot right after it (`{ screenshot: true }`), in the same round
 * trip.
 *
 * A mouse or keyboard action is sent again only when it can't have reached
 * the machine; after any other failure it is unknown whether it ran, and a
 * screenshot shows what happened. `screenshot`, `cursorPosition`, `wait` and
 * `setScreenSize` are retried like any read.
 *
 * {@link ClaudeComputer} and {@link OpenAIComputer} run Claude's and
 * OpenAI's computer-use tool calls with it.
 */
export class MachineComputer {
  constructor(
    private readonly transport: Transport,
    private readonly defaultRegion?: string,
  ) {}

  /** This namespace with its calls going to `region` unless a call names
   *  another: what the adapters use for a machine in another region, and the
   *  way to name it for `screenshot`, whose own `region` is the part of the
   *  screen to capture. */
  inRegion(region: string | undefined): MachineComputer {
    return region ? new MachineComputer(this.transport, region) : this;
  }

  /** A screenshot of the screen, or of `region` of it. */
  async screenshot(id: string, opts: ComputerScreenshotOptions = {}): Promise<ComputerScreenshotResult> {
    const result = await this.#run(id, { screenshot: {} }, { screenshot: opts }, 0, true);
    if (!result.screenshot) throw new BoxdError("the machine sent back no screenshot");
    return result as ComputerScreenshotResult;
  }

  /** The screen's size and where the pointer is. */
  async cursorPosition(id: string, opts: ComputerActionOptions = {}): Promise<ComputerActionResult> {
    return this.#run(id, { cursorPosition: {} }, opts, 0, true);
  }

  /** Move the pointer without clicking, e.g. to hover. */
  /**
   * Hold the screen at `width`×`height` (320×200 to 5120×2880) until
   * {@link releaseScreenSize} or the desktop restarts. While it is held,
   * someone watching in the console sees it scaled to fit instead of resizing
   * it, so an agent's coordinates stay put.
   */
  async setScreenSize(
    id: string,
    width: number,
    height: number,
    opts: ComputerActionOptions = {},
  ): Promise<ComputerActionResult> {
    const setScreenSize = { width: count("width", width), height: count("height", height) };
    return this.#run(id, { setScreenSize }, opts, 0, true);
  }

  /** Let go of a held screen: it follows whoever is viewing again. */
  async releaseScreenSize(id: string, opts: ComputerActionOptions = {}): Promise<ComputerActionResult> {
    return this.#run(id, { setScreenSize: { width: 0, height: 0 } }, opts, 0, true);
  }

  async move(
    id: string,
    x: number,
    y: number,
    opts: ComputerActionOptions = {},
  ): Promise<ComputerActionResult> {
    return this.#run(id, { mouseMove: { to: point(x, y) } }, opts);
  }

  /** Click, at `x`/`y` or where the pointer is. */
  async click(id: string, opts: ComputerClickOptions = {}): Promise<ComputerActionResult> {
    return this.#run(
      id,
      {
        click: {
          at: optionalPoint(opts, "click"),
          button: opts.button ?? "",
          count: count("count", opts.count ?? 0),
          modifiers: modifiers(opts.modifiers),
        },
      },
      opts,
    );
  }

  /** Press a mouse button and keep it down, for a drag done step by step. */
  async mouseDown(id: string, opts: ComputerMouseButtonOptions = {}): Promise<ComputerActionResult> {
    return this.#run(
      id,
      { mouseDown: { at: optionalPoint(opts, "mouseDown"), button: opts.button ?? "" } },
      opts,
    );
  }

  /** Release a mouse button pressed with {@link mouseDown}. */
  async mouseUp(id: string, opts: ComputerMouseButtonOptions = {}): Promise<ComputerActionResult> {
    return this.#run(
      id,
      { mouseUp: { at: optionalPoint(opts, "mouseUp"), button: opts.button ?? "" } },
      opts,
    );
  }

  /** Press at the first point, move through the rest, release at the last.
   *  At least two points. */
  async drag(
    id: string,
    path: readonly ComputerPoint[],
    opts: ComputerDragOptions = {},
  ): Promise<ComputerActionResult> {
    return this.#run(
      id,
      {
        drag: {
          path: path.map((p) => point(p.x, p.y)),
          button: opts.button ?? "",
          modifiers: modifiers(opts.modifiers),
        },
      },
      opts,
      // Each segment between two points is up to 20 small moves.
      500 * Math.max(0, path.length - 1),
    );
  }

  /** Turn the scroll wheel `dx`/`dy` clicks, at `x`/`y` or where the
   *  pointer is. */
  async scroll(id: string, opts: ComputerScrollOptions): Promise<ComputerActionResult> {
    const dx = integer("dx", opts.dx ?? 0);
    const dy = integer("dy", opts.dy ?? 0);
    return this.#run(
      id,
      {
        scroll: {
          at: optionalPoint(opts, "scroll"),
          deltaX: dx,
          deltaY: dy,
          modifiers: modifiers(opts.modifiers),
        },
      },
      opts,
      30 * (Math.abs(dx) + Math.abs(dy)),
    );
  }

  /** Type text where the keyboard focus is, as a person would on a US
   *  keyboard layout. */
  async type(id: string, text: string, opts: ComputerActionOptions = {}): Promise<ComputerActionResult> {
    return this.#run(id, { type: { text } }, opts, 30 * text.length);
  }

  /**
   * Press a key or a `"+"`-joined combination (`"Return"`, `"ctrl+s"`,
   * `"alt+Tab"`), or several separated by spaces, pressed in turn. Names are
   * X keysyms as xdotool takes them, plus common aliases (`"enter"`,
   * `"esc"`, `"cmd"`, `"arrowleft"`, `"pageup"`), case-insensitive.
   */
  async key(id: string, keys: string, opts: ComputerKeyOptions = {}): Promise<ComputerActionResult> {
    const repeat = count("repeat", opts.repeat ?? 0);
    const holdMs = count("holdMs", opts.holdMs ?? 0);
    const presses = keys.split(/\s+/).filter(Boolean).length * Math.max(1, repeat);
    return this.#run(id, { key: { keys, repeat, holdMs } }, opts, holdMs + 40 * presses);
  }

  /** Do nothing for `ms` milliseconds (up to 300000), e.g. while an app
   *  loads; with `{ screenshot: true }`, then look. */
  async wait(id: string, ms: number, opts: ComputerActionOptions = {}): Promise<ComputerActionResult> {
    const waitMs = count("ms", ms);
    return this.#run(id, { wait: { ms: waitMs } }, opts, waitMs, true);
  }

  /**
   * One `ComputerAction` call. `extraMs` is how long the action itself takes
   * on top of the usual, so the deadline allows for it. A `readOnly` action
   * is retried like any read; any other only when it never reached the
   * machine.
   */
  async #run(
    id: string,
    action: Partial<ComputerActionRequest>,
    opts: ComputerActionOptions,
    extraMs = 0,
    readOnly = false,
  ): Promise<ComputerActionResult> {
    const shot = opts.screenshot === true ? {} : opts.screenshot || undefined;
    const req: ComputerActionRequest = {
      ...action,
      vmId: id,
      returnScreenshot: shot !== undefined,
      screenshotOptions: shot ? toWireScreenshot(shot) : undefined,
    };
    const callOpts = {
      extraTimeoutMs: extraMs + (shot?.delayMs ?? 0),
      retry: readOnly,
      region: opts.region ?? this.defaultRegion,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return toResult(await this.transport.unary(BoxdApiDefinition.methods.computerAction, req, callOpts));
      } catch (err) {
        const backoff = RETRY_BACKOFF_MS[attempt];
        if (readOnly || backoff === undefined || !neverSent(err)) throw err;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}

/** A failure that proves the action never reached the machine: the server
 *  couldn't reach its agent, or no connection to the server was made. */
function neverSent(err: unknown): boolean {
  return (
    agentUnreachable(err) ||
    (err instanceof APIConnectionError && err.message.startsWith("No connection established"))
  );
}

function toWireScreenshot(o: ComputerScreenshotOptions): WireScreenshotOptions {
  const r = o.region;
  return {
    format: o.format ?? "",
    quality: count("quality", o.quality ?? 0),
    maxWidth: count("maxWidth", o.maxWidth ?? 0),
    maxHeight: count("maxHeight", o.maxHeight ?? 0),
    region: r
      ? {
          x: integer("region.x", r.x),
          y: integer("region.y", r.y),
          width: integer("region.width", r.width),
          height: integer("region.height", r.height),
        }
      : undefined,
    delayMs: count("delayMs", o.delayMs ?? 0),
  };
}

function toResult(r: ComputerActionResponse): ComputerActionResult {
  const out: ComputerActionResult = {
    screenWidth: r.screenWidth,
    screenHeight: r.screenHeight,
    screenHeld: r.screenHeld,
    cursor: { x: r.cursor?.x ?? 0, y: r.cursor?.y ?? 0 },
  };
  if (r.screenshot) {
    out.screenshot = {
      // A copy: the decoded message's bytes are a view into the whole response.
      data: r.screenshot.data.slice(),
      mimeType: r.screenshot.mimeType,
      width: r.screenshot.width,
      height: r.screenshot.height,
    };
  }
  return out;
}

function modifiers(m: string | readonly string[] | undefined): string {
  return typeof m === "string" ? m : (m ?? []).join("+");
}

function point(x: number, y: number): WirePoint {
  return { x: integer("x", x), y: integer("y", y) };
}

function optionalPoint(p: { x?: number; y?: number }, what: string): WirePoint | undefined {
  if (p.x === undefined && p.y === undefined) return undefined;
  if (p.x === undefined || p.y === undefined) {
    throw new TypeError(`${what}: give both x and y, or neither`);
  }
  return point(p.x, p.y);
}

/** A whole number for the wire (int32 fields): rounded, never NaN. */
function integer(name: string, v: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`${name} must be a number, got ${String(v)}`);
  }
  return Math.round(v);
}

/** A count for an unsigned field: a negative one can't be sent. */
function count(name: string, v: number): number {
  const n = integer(name, v);
  if (n < 0) throw new RangeError(`${name} must not be negative, got ${v}`);
  return n;
}
