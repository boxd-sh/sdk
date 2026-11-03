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
  ComputerActionOptions,
  ComputerActionResult,
  ComputerButton,
  ComputerImageFormat,
  ComputerScreenshot,
  ComputerScreenshotOptions,
  MachineComputer,
} from "./computer.js";
import { AuthenticationError, NotFoundError, PermissionDeniedError } from "./errors.js";

/** The `type` of Claude's computer use toolset that {@link ClaudeComputer} runs. */
export const CLAUDE_COMPUTER_TOOLSET = "computer_toolset_20260801";

/** The text Claude expects for the actions of a batch after one that failed. */
const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";

/** Claude's limits for an image in a tool result. */
const MAX_EDGE = 2576;
const MAX_TILES = 4784;
const TILE = 28;

const CLICKS: Record<string, { button: ComputerButton; count: number }> = {
  left_click: { button: "left", count: 1 },
  right_click: { button: "right", count: 1 },
  middle_click: { button: "middle", count: 1 },
  double_click: { button: "left", count: 2 },
  triple_click: { button: "left", count: 3 },
};

/** Members whose call can carry the screenshot a `screenshot` block right
 *  after them asks for, saving a round trip. */
const CARRIES_SCREENSHOT = new Set([
  ...Object.keys(CLICKS),
  "left_click_drag",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "cursor_position",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
]);

export interface ClaudeComputerOptions extends RegionOption {
  /** The size to hold the screen at from the first action on, so that
   *  someone watching in the console doesn't resize it mid-run. Default
   *  1280×800; `null` leaves the screen alone. Let go with `release()`. */
  screenSize?: ComputerScreenSize | null;
  /** The largest screenshot Claude is shown, in pixels; the screen is
   *  scaled down to fit. Default 1280×800. At most 2576 per side, and
   *  ⌈width/28⌉ × ⌈height/28⌉ at most 4784. */
  maxWidth?: number;
  maxHeight?: number;
  /** Screenshot encoding. Default `"png"`. */
  format?: ComputerImageFormat;
  /** JPEG and WebP quality, 1-100. Default 80. */
  quality?: number;
  /** Wait this long after an action before a screenshot, so the screen can
   *  catch up. Default 300 ms. */
  settleMs?: number;
}

/** The `tools` entry for Claude's computer use toolset. */
export interface ClaudeComputerToolset {
  type: typeof CLAUDE_COMPUTER_TOOLSET;
}

export interface ClaudeTextContent {
  type: "text";
  text: string;
}

export interface ClaudeImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/webp";
    data: string;
  };
}

/** A `tool_result` block answering one of Claude's computer actions. */
export interface ClaudeComputerToolResult {
  type: "tool_result";
  tool_use_id: string;
  toolset_name: "computer";
  content: string | Array<ClaudeTextContent | ClaudeImageContent>;
  is_error?: boolean;
}

/** A content block of Claude's reply, as the Messages API returns it. */
export interface ClaudeContentBlock {
  readonly type: string;
}

interface ComputerToolUse {
  type: "tool_use";
  id: string;
  name: string;
  toolset_name: "computer";
  input?: unknown;
}

type Content = ClaudeComputerToolResult["content"];

/**
 * Runs Claude's computer use (the `computer_toolset_20260801` toolset) on a
 * machine's desktop. Plain objects in and out, so it works with the
 * Anthropic SDK or without it:
 *
 * ```ts
 * const computer = new ClaudeComputer(boxd, "my-machine");
 * const response = await anthropic.messages.create({ ..., tools: [computer.tool] });
 * messages.push({ role: "assistant", content: response.content });
 * messages.push({ role: "user", content: await computer.run(response.content) });
 * ```
 *
 * Screenshots are scaled down to fit `maxWidth`×`maxHeight` (default
 * 1280×800), and the coordinates Claude sends, which are in the pixel space
 * of those screenshots, are scaled back to the screen. One instance belongs
 * to one conversation.
 */
export class ClaudeComputer {
  readonly #computer: MachineComputer;
  readonly #shot: ComputerScreenshotOptions;
  readonly #scale: ScreenshotScale;
  readonly #hold: ScreenHold;

  /** `client` is a `Boxd` client or its `machines.computer`; `machine` the
   *  machine's name or id. */
  constructor(
    client: ComputerClient,
    readonly machine: string,
    opts: ClaudeComputerOptions = {},
  ) {
    const maxWidth = opts.maxWidth ?? 1280;
    const maxHeight = opts.maxHeight ?? 800;
    checkImageLimits(maxWidth, maxHeight);
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
  }

  /** The `tools` entry to send with every request. Add `configs` to it to
   *  turn members off (`{ zoom: { enabled: false } }`). */
  get tool(): ClaudeComputerToolset {
    return { type: CLAUDE_COMPUTER_TOOLSET };
  }

  /** Let go of the screen: it follows whoever is viewing again. Call it when
   *  the agent is done. */
  async release(): Promise<void> {
    await this.#hold.release();
  }

  /**
   * Run the computer actions in an assistant message's `content` and return
   * their `tool_result` blocks, one for each, for the next user message.
   * Blocks that aren't the computer toolset's (text, thinking, other tools)
   * are skipped.
   *
   * The actions run in order. After one fails, its result says why
   * (`is_error`) and the rest are not run (their results say so), since
   * Claude planned them on the failed one. An error about the credentials
   * or the machine itself (`AuthenticationError`, `PermissionDeniedError`,
   * `NotFoundError`) is thrown instead: Claude can't fix it.
   */
  async run(content: readonly ClaudeContentBlock[]): Promise<ClaudeComputerToolResult[]> {
    const calls = content.filter(isComputerToolUse);
    const results: ClaudeComputerToolResult[] = [];
    if (calls.length > 0) await this.#hold.ensure();
    let failed = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (failed) {
        results.push(errorResult(call.id, NOT_EXECUTED));
        continue;
      }
      // A screenshot right after an action rides on the action's call.
      const next = calls[i + 1];
      const carry = next?.name === "screenshot" && CARRIES_SCREENSHOT.has(call.name);
      try {
        const out = await this.#act(call.name, inputOf(call), carry);
        results.push(okResult(call.id, out.content));
        if (carry && out.result?.screenshot) {
          results.push(okResult(next.id, [imageContent(out.result.screenshot)]));
          i++;
        }
      } catch (err) {
        if (
          err instanceof AuthenticationError ||
          err instanceof PermissionDeniedError ||
          err instanceof NotFoundError
        ) {
          throw err;
        }
        failed = true;
        results.push(errorResult(call.id, err instanceof Error ? err.message : String(err)));
      }
    }
    return results;
  }

  async #act(
    name: string,
    input: Record<string, unknown>,
    carry: boolean,
  ): Promise<{ content: Content; result?: ComputerActionResult }> {
    const c = this.#computer;
    const m = this.machine;
    const shot: ComputerActionOptions = carry ? { screenshot: this.#shot } : {};
    const done = (result: ComputerActionResult, text = "OK") => {
      // A screenshot taken with an action is a full one: it sets the scale.
      this.#scale.observe(result);
      return { content: text, result };
    };
    const click = CLICKS[name];
    if (click) {
      const at = await this.#optionalAt(input, "coordinate");
      return done(await c.click(m, { ...at, ...click, modifiers: modifiersOf(input), ...shot }));
    }
    switch (name) {
      case "screenshot": {
        const r = await c.screenshot(m, this.#shot);
        this.#scale.observe(r);
        return { content: [imageContent(r.screenshot)] };
      }
      case "zoom": {
        const [x0, y0, x1, y1] = numbers(input, "region", 4);
        const region = await this.#scale.regionToScreen(x0!, y0!, x1!, y1!);
        // Not observed: a zoom must not change the scale of Claude's coordinates.
        const r = await c.screenshot(m, { ...this.#shot, region });
        return { content: [imageContent(r.screenshot)] };
      }
      case "left_click_drag": {
        const from = await this.#at(input, "start_coordinate");
        const to = await this.#at(input, "coordinate");
        return done(await c.drag(m, [from, to], { modifiers: modifiersOf(input), ...shot }));
      }
      case "mouse_move": {
        const to = await this.#at(input, "coordinate");
        return done(await c.move(m, to.x, to.y, shot));
      }
      case "left_mouse_down":
        return done(await c.mouseDown(m, { ...(await this.#optionalAt(input, "coordinate")), ...shot }));
      case "left_mouse_up":
        return done(await c.mouseUp(m, { ...(await this.#optionalAt(input, "coordinate")), ...shot }));
      case "cursor_position": {
        const r = await c.cursorPosition(m, shot);
        this.#scale.observe(r);
        const p = await this.#scale.toImage(r.cursor);
        return done(r, `X=${p.x}, Y=${p.y}`);
      }
      case "scroll": {
        const direction = input.scroll_direction;
        const amount = numbers(input, "scroll_amount", 1)[0]!;
        if (!Number.isInteger(amount) || amount < 0) {
          throw new Error(`scroll_amount must be a whole number of wheel clicks, got ${JSON.stringify(input.scroll_amount)}`);
        }
        const sign = direction === "up" || direction === "left" ? -1 : direction === "down" || direction === "right" ? 1 : 0;
        if (sign === 0) {
          throw new Error(`scroll_direction must be up, down, left or right, got ${JSON.stringify(direction)}`);
        }
        const horizontal = direction === "left" || direction === "right";
        const at = await this.#optionalAt(input, "coordinate");
        return done(
          await c.scroll(m, {
            ...at,
            dx: horizontal ? sign * amount : 0,
            dy: horizontal ? 0 : sign * amount,
            modifiers: modifiersOf(input),
            ...shot,
          }),
        );
      }
      case "type":
        return done(await c.type(m, requiredString(input, "text"), shot));
      case "key": {
        const repeat = input.repeat == null ? undefined : numbers(input, "repeat", 1)[0];
        return done(await c.key(m, requiredString(input, "text"), { repeat, ...shot }));
      }
      case "hold_key": {
        const holdMs = seconds(input, "duration");
        return done(await c.key(m, requiredString(input, "text"), { holdMs, ...shot }));
      }
      case "wait":
        return done(await c.wait(m, seconds(input, "duration"), shot));
      default:
        throw new Error(`unknown computer action "${name}"`);
    }
  }

  async #at(input: Record<string, unknown>, key: string): Promise<{ x: number; y: number }> {
    const [x, y] = numbers(input, key, 2);
    return this.#scale.toScreen(x!, y!);
  }

  async #optionalAt(input: Record<string, unknown>, key: string): Promise<{ x?: number; y?: number }> {
    return input[key] == null ? {} : this.#at(input, key);
  }
}

function isComputerToolUse(block: ClaudeContentBlock): block is ClaudeContentBlock & ComputerToolUse {
  const b = block as Partial<ComputerToolUse>;
  return (
    b.type === "tool_use" &&
    b.toolset_name === "computer" &&
    typeof b.id === "string" &&
    typeof b.name === "string"
  );
}

function inputOf(call: ComputerToolUse): Record<string, unknown> {
  const input = call.input;
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function okResult(id: string, content: Content): ClaudeComputerToolResult {
  return { type: "tool_result", tool_use_id: id, toolset_name: "computer", content };
}

function errorResult(id: string, message: string): ClaudeComputerToolResult {
  return { type: "tool_result", tool_use_id: id, toolset_name: "computer", is_error: true, content: message };
}

function imageContent(s: ComputerScreenshot): ClaudeImageContent {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: s.mimeType as ClaudeImageContent["source"]["media_type"],
      data: toBase64(s.data),
    },
  };
}

/** The keys a click, drag or scroll holds down: its `text`. */
function modifiersOf(input: Record<string, unknown>): string | undefined {
  return typeof input.text === "string" ? input.text : undefined;
}

/** `n` finite numbers: `input[key]` itself for one, an array of `n` otherwise. */
function numbers(input: Record<string, unknown>, key: string, n: number): number[] {
  const v = input[key];
  const list = n === 1 && !Array.isArray(v) ? [v] : v;
  if (!Array.isArray(list) || list.length !== n || !list.every((x) => typeof x === "number" && Number.isFinite(x))) {
    const shape = n === 1 ? "a number" : n === 2 ? "[x, y]" : "[x0, y0, x1, y1]";
    throw new Error(`${key} must be ${shape}, got ${JSON.stringify(v)}`);
  }
  return list as number[];
}

function seconds(input: Record<string, unknown>, key: string): number {
  const s = numbers(input, key, 1)[0]!;
  if (s < 0) throw new Error(`${key} must not be negative, got ${s}`);
  return Math.round(s * 1000);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`${key} must be a string, got ${JSON.stringify(v)}`);
  return v;
}

function checkImageLimits(width: number, height: number): void {
  const ok =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= MAX_EDGE &&
    height <= MAX_EDGE &&
    Math.ceil(width / TILE) * Math.ceil(height / TILE) <= MAX_TILES;
  if (!ok) {
    throw new RangeError(
      `maxWidth/maxHeight ${width}x${height} is outside Claude's image limits: whole pixels, ` +
        `at most ${MAX_EDGE} per side and ⌈w/${TILE}⌉×⌈h/${TILE}⌉ at most ${MAX_TILES}`,
    );
  }
}
