/**
 * @internal
 * What the computer-use adapters (`computerClaude.ts`, `computerOpenAI.ts`)
 * share: mapping a model's coordinates, which are in the pixel space of the
 * screenshots it was shown, to screen pixels and back, and base64 for the
 * images. Not exported from the package.
 */
import type {
  ComputerActionResult,
  ComputerPoint,
  ComputerRegion,
  MachineComputer,
} from "./computer.js";

interface Size {
  width: number;
  height: number;
}

/**
 * The size a `width`×`height` screen's screenshot comes out at when scaled
 * down to fit `maxWidth`×`maxHeight`, the way the machine scales it: keeping
 * its shape, never scaling up.
 */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): Size {
  const f = Math.min(1, maxWidth / width, maxHeight / height);
  if (f >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)) };
}

/**
 * The scale between the screenshots a model sees and the screen. It is set
 * by the latest full screenshot (its size against the screen's); a zoomed
 * screenshot never changes it, since models keep using full-screenshot
 * coordinates after one. Before any screenshot, it is the scale a screenshot
 * would have, from the screen's size.
 */
export class ScreenshotScale {
  #image?: Size;
  #screen?: Size;

  constructor(
    private readonly computer: MachineComputer,
    private readonly machine: string,
    private readonly maxWidth: number,
    private readonly maxHeight: number,
  ) {}

  /** Take the scale from a full screenshot. Results without one, or zoomed
   *  ones, must not be passed. */
  observe(result: ComputerActionResult): void {
    if (!result.screenshot) return;
    this.#image = { width: result.screenshot.width, height: result.screenshot.height };
    this.#screen = { width: result.screenWidth, height: result.screenHeight };
  }

  /** The size of the screenshots the model sees. */
  async imageSize(): Promise<Size> {
    return (await this.#sizes()).image;
  }

  /** A point in screenshot pixels, as screen pixels: rounded, and kept on
   *  the screen. */
  async toScreen(x: number, y: number): Promise<ComputerPoint> {
    const { image, screen } = await this.#sizes();
    return {
      x: clamp(Math.round((x * screen.width) / image.width), 0, screen.width - 1),
      y: clamp(Math.round((y * screen.height) / image.height), 0, screen.height - 1),
    };
  }

  /** A point in screen pixels, as screenshot pixels. */
  async toImage(p: ComputerPoint): Promise<ComputerPoint> {
    const { image, screen } = await this.#sizes();
    return {
      x: clamp(Math.round((p.x * image.width) / screen.width), 0, image.width - 1),
      y: clamp(Math.round((p.y * image.height) / screen.height), 0, image.height - 1),
    };
  }

  /** The rectangle between two corners given in screenshot pixels, in
   *  screen pixels, kept on the screen and at least 1×1. */
  async regionToScreen(x0: number, y0: number, x1: number, y1: number): Promise<ComputerRegion> {
    const { image, screen } = await this.#sizes();
    const sx = (v: number) => clamp(Math.round((v * screen.width) / image.width), 0, screen.width);
    const sy = (v: number) => clamp(Math.round((v * screen.height) / image.height), 0, screen.height);
    const left = Math.min(sx(Math.min(x0, x1)), screen.width - 1);
    const top = Math.min(sy(Math.min(y0, y1)), screen.height - 1);
    const right = Math.max(sx(Math.max(x0, x1)), left + 1);
    const bottom = Math.max(sy(Math.max(y0, y1)), top + 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  async #sizes(): Promise<{ image: Size; screen: Size }> {
    if (!this.#image || !this.#screen) {
      const r = await this.computer.cursorPosition(this.machine);
      this.#screen = { width: r.screenWidth, height: r.screenHeight };
      this.#image = fitWithin(r.screenWidth, r.screenHeight, this.maxWidth, this.maxHeight);
    }
    return { image: this.#image, screen: this.#screen };
  }
}

/** The screen size an adapter holds unless told otherwise. */
export const DEFAULT_SCREEN_SIZE: ComputerScreenSize = { width: 1280, height: 800 };

/** A screen size in pixels. */
export interface ComputerScreenSize {
  width: number;
  height: number;
}

/**
 * Holds the screen at one size from an adapter's first action on, so that
 * someone opening the Desktop view mid-run doesn't resize it. `null` leaves
 * the screen alone.
 */
export class ScreenHold {
  #holding = false;

  constructor(
    private readonly computer: MachineComputer,
    private readonly machine: string,
    private readonly size: ComputerScreenSize | null,
  ) {}

  /** Before the first action; nothing after that. */
  async ensure(): Promise<void> {
    if (!this.size || this.#holding) return;
    await this.computer.setScreenSize(this.machine, this.size.width, this.size.height);
    this.#holding = true;
  }

  /** Let go of the screen. */
  async release(): Promise<void> {
    await this.computer.releaseScreenSize(this.machine);
    this.#holding = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** What the adapters accept as the way to the machine: a client
 *  (`new Boxd()`), or its `machines.computer`. */
export type ComputerClient = MachineComputer | { readonly machines: { readonly computer: MachineComputer } };

export function computerOf(client: ComputerClient): MachineComputer {
  return "machines" in client ? client.machines.computer : client;
}

/** Base64 without Node's `Buffer`, so it also runs in a browser or a Worker. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
