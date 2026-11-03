import {
  DEFAULT_SCREEN_SIZE,
  ScreenHold,
  ScreenshotScale,
  computerOf,
  toBase64,
  type ComputerClient,
  type ComputerScreenSize,
} from "./_computerScale.js";
import type { RegionOption } from "./regions.js";
import type {
  ComputerActionResult,
  ComputerButton,
  ComputerImageFormat,
  ComputerPoint,
  ComputerScreenshotOptions,
  MachineComputer,
} from "./computer.js";
import { BoxdError } from "./errors.js";

/** The server's limit on wheel clicks per scroll, each way. */
const MAX_SCROLL_CLICKS = 100;

export interface OpenAIComputerOptions extends RegionOption {
  /** The size to hold the screen at from the first action on, so that
   *  someone watching in the console doesn't resize it mid-run. Default
   *  1280×800; `null` leaves the screen alone. Let go with `release()`. */
  screenSize?: ComputerScreenSize | null;
  /** The largest screenshot the model is shown, in pixels; the screen is
   *  scaled down to fit. Default 1600×900. */
  maxWidth?: number;
  maxHeight?: number;
  /** Screenshot encoding. Default `"png"`. */
  format?: ComputerImageFormat;
  /** JPEG and WebP quality, 1-100. Default 80. */
  quality?: number;
  /** Wait this long after the actions before the screenshot, so the screen
   *  can catch up. Default 300 ms. */
  settleMs?: number;
  /** Pixels one scroll-wheel click stands for: a `scroll` action's
   *  `scroll_x`/`scroll_y` become that many clicks, at least one. Default 100
   *  (OpenAI's own recipe; Chromium on the desktop scrolls about 120 px per
   *  click), as in the Python SDK. */
  scrollPixelsPerClick?: number;
  /** How long a `wait` action waits. Default 2000 ms. */
  waitMs?: number;
}

export interface OpenAIRunOptions {
  /**
   * What to do with a call's `pending_safety_checks`: `true` runs it anyway,
   * or a function decides from the checks. Acknowledged checks are sent back
   * with the output. Default: throw {@link PendingSafetyCheckError}.
   */
  acknowledgeSafetyChecks?: boolean | ((checks: OpenAISafetyCheck[]) => boolean | Promise<boolean>);
}

export interface OpenAISafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

/** An item of a response's `output`, as the Responses API returns it. */
export interface OpenAIOutputItem {
  readonly type: string;
}

/** The parts of a `computer_call` output item that {@link OpenAIComputer.run} reads. */
export interface OpenAIComputerCall {
  type: "computer_call";
  call_id: string;
  /** The current computer tool sends `actions`, several in order. */
  actions?: readonly OpenAIOutputItem[] | null;
  /** `computer_use_preview` sends one `action`. */
  action?: OpenAIOutputItem | null;
  pending_safety_checks?: readonly OpenAISafetyCheck[] | null;
}

/** The `computer_call_output` input item answering a `computer_call`. */
export interface OpenAIComputerCallOutput {
  type: "computer_call_output";
  call_id: string;
  output: {
    type: "computer_screenshot";
    /** A `data:` URL. */
    image_url: string;
    /** `"original"` for the current computer tool: the model sees the
     *  screenshot at full resolution. */
    detail?: "original";
  };
  acknowledged_safety_checks?: OpenAISafetyCheck[];
}

/** The `tools` entry for OpenAI's computer tool. */
export interface OpenAIComputerTool {
  type: "computer";
}

/** The `tools` entry for the older `computer_use_preview` tool. */
export interface OpenAIComputerUsePreviewTool {
  type: "computer_use_preview";
  display_width: number;
  display_height: number;
  environment: "linux";
}

/** An OpenAI `computer_call` carries safety checks nobody acknowledged.
 *  Nothing in that call ran. Show `checks` to a person; to go on, pass
 *  `acknowledgeSafetyChecks` to `run()`. */
export class PendingSafetyCheckError extends BoxdError {
  constructor(
    readonly callId: string,
    readonly checks: OpenAISafetyCheck[],
  ) {
    const summary = checks.map((c) => c.message || c.code || c.id).join("; ");
    super(`computer call ${callId} needs its safety checks acknowledged: ${summary}`);
    this.name = "PendingSafetyCheckError";
  }
}

const BUTTONS: Record<string, ComputerButton> = {
  left: "left",
  right: "right",
  wheel: "middle",
  back: "back",
  forward: "forward",
};

/**
 * Runs OpenAI's computer use (the Responses API `computer` tool, or the older
 * `computer_use_preview`) on a machine's desktop. Plain objects in and out,
 * so it works with the OpenAI SDK or without it:
 *
 * ```ts
 * const computer = new OpenAIComputer(boxd, "my-machine");
 * const response = await openai.responses.create({ ..., tools: [computer.tool] });
 * input.push(...response.output, ...(await computer.run(response.output)));
 * ```
 *
 * Every call's actions run in order, then a screenshot shows the result.
 * Screenshots are scaled down to fit `maxWidth`×`maxHeight` (default
 * 1600×900), and the model's coordinates, which are in the pixel space of
 * those screenshots, are scaled back to the screen. One instance belongs to
 * one conversation.
 */
export class OpenAIComputer {
  readonly #computer: MachineComputer;
  readonly #shot: ComputerScreenshotOptions;
  readonly #scale: ScreenshotScale;
  readonly #hold: ScreenHold;
  readonly #pixelsPerClick: number;
  readonly #waitMs: number;

  /** `client` is a `Boxd` client or its `machines.computer`; `machine` the
   *  machine's name or id. */
  constructor(
    client: ComputerClient,
    readonly machine: string,
    opts: OpenAIComputerOptions = {},
  ) {
    const maxWidth = opts.maxWidth ?? 1600;
    const maxHeight = opts.maxHeight ?? 900;
    this.#computer = computerOf(client).inRegion(opts.region);
    this.#shot = {
      format: opts.format,
      quality: opts.quality,
      maxWidth,
      maxHeight,
      delayMs: opts.settleMs ?? 300,
    };
    this.#scale = new ScreenshotScale(this.#computer, machine, maxWidth, maxHeight);
    this.#hold = new ScreenHold(
      this.#computer,
      machine,
      opts.screenSize === undefined ? DEFAULT_SCREEN_SIZE : opts.screenSize,
    );
    this.#pixelsPerClick = opts.scrollPixelsPerClick ?? 100;
    if (!(this.#pixelsPerClick > 0)) throw new RangeError("scrollPixelsPerClick must be positive");
    this.#waitMs = opts.waitMs ?? 2000;
  }

  /** The `tools` entry for the current computer tool. */
  get tool(): OpenAIComputerTool {
    return { type: "computer" };
  }

  /** The `tools` entry for the older `computer_use_preview` tool, whose
   *  display size is the size of the screenshots the model is shown. */
  async previewTool(): Promise<OpenAIComputerUsePreviewTool> {
    await this.#hold.ensure();
    const size = await this.#scale.imageSize();
    return {
      type: "computer_use_preview",
      display_width: size.width,
      display_height: size.height,
      environment: "linux",
    };
  }

  /**
   * Run every `computer_call` in a response's `output` (or the response
   * itself) and return one `computer_call_output` for each, with a
   * screenshot of the result, for the next request's `input`. Other items
   * are skipped.
   *
   * A call's actions run in order. A failed action throws, and nothing
   * after it runs. A call with pending safety checks throws
   * {@link PendingSafetyCheckError} before running anything, unless
   * `acknowledgeSafetyChecks` allows it.
   */
  /** Let go of the screen: it follows whoever is viewing again. Call it when
   *  the agent is done. */
  async release(): Promise<void> {
    await this.#hold.release();
  }

  async run(
    output: readonly OpenAIOutputItem[] | { readonly output: readonly OpenAIOutputItem[] },
    opts: OpenAIRunOptions = {},
  ): Promise<OpenAIComputerCallOutput[]> {
    const items = "output" in output ? output.output : output;
    const outputs: OpenAIComputerCallOutput[] = [];
    for (const item of items) {
      if (item.type === "computer_call") outputs.push(await this.#call(item as OpenAIComputerCall, opts));
    }
    return outputs;
  }

  async #call(call: OpenAIComputerCall, opts: OpenAIRunOptions): Promise<OpenAIComputerCallOutput> {
    const checks = [...(call.pending_safety_checks ?? [])];
    if (checks.length > 0) {
      const ack = opts.acknowledgeSafetyChecks;
      const ok = typeof ack === "function" ? await ack(checks) : ack === true;
      if (!ok) throw new PendingSafetyCheckError(call.call_id, checks);
    }
    await this.#hold.ensure();
    const batched = call.actions != null;
    const actions = call.actions ?? (call.action ? [call.action] : []);
    // The screenshot after the call rides on its last action that isn't a
    // screenshot; a screenshot action itself changes nothing.
    let last = -1;
    actions.forEach((a, i) => {
      if (a.type !== "screenshot") last = i;
    });
    let result: ComputerActionResult | undefined;
    for (let i = 0; i <= last; i++) {
      if (actions[i]!.type === "screenshot") continue;
      result = await this.#act(actions[i]!, i === last);
    }
    if (!result?.screenshot) result = await this.#computer.screenshot(this.machine, this.#shot);
    this.#scale.observe(result);
    const shot = result.screenshot!;
    const out: OpenAIComputerCallOutput = {
      type: "computer_call_output",
      call_id: call.call_id,
      output: {
        type: "computer_screenshot",
        image_url: `data:${shot.mimeType};base64,${toBase64(shot.data)}`,
      },
    };
    if (batched) out.output.detail = "original";
    if (checks.length > 0) out.acknowledged_safety_checks = checks;
    return out;
  }

  async #act(action: OpenAIOutputItem, last: boolean): Promise<ComputerActionResult | undefined> {
    const a = action as unknown as Record<string, unknown>;
    const c = this.#computer;
    const m = this.machine;
    const shot = last ? { screenshot: this.#shot } : {};
    switch (action.type) {
      case "click":
      case "double_click": {
        const button = BUTTONS[String(a.button ?? "left")];
        if (!button) throw new BoxdError(`${action.type}: unknown mouse button ${JSON.stringify(a.button)}`);
        const count = action.type === "double_click" ? 2 : 1;
        return c.click(m, { ...(await this.#at(a)), button, count, modifiers: modifiers(a), ...shot });
      }
      case "drag": {
        if (!Array.isArray(a.path)) throw new BoxdError("drag: path must be a list of points");
        const path: ComputerPoint[] = [];
        for (const p of a.path as unknown[]) path.push(await this.#at((p ?? {}) as Record<string, unknown>));
        return c.drag(m, path, { modifiers: modifiers(a), ...shot });
      }
      case "move": {
        const to = await this.#at(a);
        return c.move(m, to.x, to.y, shot);
      }
      case "scroll": {
        const dx = this.#clicks(a.scroll_x);
        const dy = this.#clicks(a.scroll_y);
        const at = await this.#at(a);
        // Nothing to scroll: still move there, as the scroll would have.
        if (dx === 0 && dy === 0) return c.move(m, at.x, at.y, shot);
        return c.scroll(m, { ...at, dx, dy, modifiers: modifiers(a), ...shot });
      }
      case "keypress": {
        if (!Array.isArray(a.keys) || a.keys.length === 0) {
          throw new BoxdError("keypress: keys must be a list of keys");
        }
        return c.key(m, combo(a.keys as unknown[]), shot);
      }
      case "type":
        if (typeof a.text !== "string") throw new BoxdError("type: text must be a string");
        return c.type(m, a.text, shot);
      case "wait": {
        // A wait that says how long; otherwise `waitMs`.
        const ms = typeof a.ms === "number" && Number.isInteger(a.ms) && a.ms >= 0 ? a.ms : this.#waitMs;
        return c.wait(m, ms, shot);
      }
      default:
        throw new BoxdError(`unknown computer action "${action.type}"`);
    }
  }

  async #at(a: Record<string, unknown>): Promise<ComputerPoint> {
    const { x, y } = a;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BoxdError(`a point needs numbers x and y, got ${JSON.stringify({ x, y })}`);
    }
    return this.#scale.toScreen(x, y);
  }

  /** Scroll pixels as wheel clicks: at least one when there is any, at most
   *  what one call may scroll. */
  #clicks(pixels: unknown): number {
    const p = typeof pixels === "number" && Number.isFinite(pixels) ? pixels : 0;
    if (p === 0) return 0;
    const n = Math.min(MAX_SCROLL_CLICKS, Math.max(1, Math.round(Math.abs(p) / this.#pixelsPerClick)));
    return Math.sign(p) * n;
  }
}

/** A mouse action's held `keys`, as `"ctrl+shift"`. */
function modifiers(a: Record<string, unknown>): string | undefined {
  return Array.isArray(a.keys) && a.keys.length > 0 ? a.keys.map(String).join("+") : undefined;
}

/**
 * `keypress` keys as one `"+"` combination. The machine knows OpenAI's key
 * names (`CTRL`, `ENTER`, `ARROWLEFT`, ...) case-insensitively; a lone capital
 * letter is the letter's key (`["CTRL", "A"]` is ctrl+a, not ctrl+shift+a),
 * and a space is the space bar.
 */
function combo(keys: unknown[]): string {
  return keys
    .map(String)
    .map((k) => (k === " " ? "space" : /^[A-Z]$/.test(k) ? k.toLowerCase() : k))
    .join("+");
}
