"""Computer-use adapters: run a model's computer-use tool calls on a boxd
machine's desktop.

- :class:`ClaudeComputer` for Claude's computer toolset
  (``{"type": "computer_toolset_20260801"}``).
- :class:`OpenAIComputer` for OpenAI's computer tool (``{"type": "computer"}``,
  and the earlier ``computer_use_preview``).

Each has an async twin (:class:`AsyncClaudeComputer`,
:class:`AsyncOpenAIComputer`). None of them needs the ``anthropic`` or
``openai`` package: they read the model's output as those SDKs' objects or as
plain dicts, and return plain dicts to send back.

Coordinates: the model sees screenshots scaled down to fit ``max_width`` x
``max_height`` and answers in that image's pixels. The adapter keeps the scale
of the latest full screenshot and maps every coordinate back to screen pixels
(rounded, clamped to the screen) before acting. One adapter belongs to one
conversation.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Generator, Mapping
from typing import Any

from .errors import AuthenticationError, BoxdError, NotFoundError, PermissionDeniedError
from .models import ComputerActionResult, Screenshot, ScreenshotOptions

__all__ = [
    "CLAUDE_COMPUTER_TOOLSET",
    "AsyncClaudeComputer",
    "AsyncOpenAIComputer",
    "ClaudeComputer",
    "OpenAIComputer",
    "PendingSafetyCheckError",
]

CLAUDE_COMPUTER_TOOLSET = "computer_toolset_20260801"
"""The tool type of Claude's computer toolset."""

_NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed."

# Claude's image limits: the long edge, and ⌈w/28⌉ × ⌈h/28⌉ tiles.
_CLAUDE_MAX_EDGE = 2576
_CLAUDE_MAX_TILES = 4784

# Errors that mean the machine can't be used at all: raised, not reported to
# the model as a failed action.
_FATAL = (AuthenticationError, PermissionDeniedError, NotFoundError)

# One request the adapter wants made: a `machines.computer` method's name and
# its keyword arguments (the machine is added by the driver).
_Call = tuple[str, dict[str, Any]]
_Steps = Generator[_Call, ComputerActionResult, Any]


class PendingSafetyCheckError(Exception):
    """An OpenAI ``computer_call`` carries safety checks nobody acknowledged.

    Nothing in that call was run. Show ``checks`` to a person; to go on, pass
    ``acknowledge_safety_checks`` to ``run()`` (True, or a function that
    decides from the checks).
    """

    def __init__(self, call_id: str, checks: list[dict[str, Any]]):
        self.call_id = call_id
        self.checks = checks
        summary = "; ".join(str(c.get("message") or c.get("code") or c) for c in checks)
        super().__init__(f"computer call {call_id} needs its safety checks acknowledged: {summary}")


class _BadInput(ValueError):
    """The model asked for something malformed: reported back to Claude as a
    failed action, raised as a ValueError from the OpenAI adapter."""


# ── reading model output ─────────────────────────────────────────────

_MISSING = object()


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """A field of a dict or an SDK object (including a pydantic model's
    extra fields, where a newer API field lands in an older SDK)."""
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    value = getattr(obj, key, _MISSING)
    if value is not _MISSING:
        return value
    extra = getattr(obj, "model_extra", None)
    if isinstance(extra, Mapping) and key in extra:
        return extra[key]
    return default


def _plain(obj: Any) -> dict[str, Any]:
    if isinstance(obj, Mapping):
        return dict(obj)
    if hasattr(obj, "model_dump"):
        return obj.model_dump(exclude_none=True)
    return {k: v for k, v in vars(obj).items() if not k.startswith("_")}


def _items(value: Any, attr: str) -> list[Any]:
    """A list of blocks/items, or the message/response holding them in `attr`."""
    if isinstance(value, (list, tuple)):
        return list(value)
    inner = _get(value, attr, _MISSING)
    if inner is not _MISSING:
        return list(inner) if isinstance(inner, (list, tuple)) else []
    return list(value)


def _number(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _BadInput(f"{what} must be a number, not {value!r}")
    if not math.isfinite(value):
        raise _BadInput(f"{what} must be a finite number, not {value!r}")
    return value


def _pair(value: Any, what: str) -> tuple[float, float]:
    if isinstance(value, Mapping):
        value = (value.get("x"), value.get("y"))
    elif not isinstance(value, (list, tuple)) and hasattr(value, "x"):
        value = (getattr(value, "x"), getattr(value, "y", None))
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise _BadInput(f"{what} must be [x, y], not {value!r}")
    return _number(value[0], what), _number(value[1], what)


# ── coordinates ──────────────────────────────────────────────────────


def _fit(width: int, height: int, max_width: int | None, max_height: int | None):
    """The size a screenshot of `width` x `height` comes back at: scaled down
    to fit, keeping its shape, never up (as the server scales it)."""
    f = 1.0
    if max_width:
        f = min(f, max_width / width)
    if max_height:
        f = min(f, max_height / height)
    if f >= 1.0:
        return width, height
    return max(1, round(width * f)), max(1, round(height * f))


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


class _View:
    """What the model sees versus the screen.

    `screen` is the latest screen size any call reported. `shot` is the
    screen and image size of the latest full screenshot the model was given:
    its coordinates are in that image's pixels until the next one. A zoom
    never changes it.
    """

    def __init__(self, max_width: int | None, max_height: int | None):
        self.max_width = max_width
        self.max_height = max_height
        self.screen: tuple[int, int] | None = None
        self.shot: tuple[int, int, int, int] | None = None

    def saw(self, result: ComputerActionResult) -> None:
        if result.screen_width > 0 and result.screen_height > 0:
            self.screen = (result.screen_width, result.screen_height)

    def saw_full(self, result: ComputerActionResult) -> None:
        self.saw(result)
        shot = result.screenshot
        if shot is not None and shot.width > 0 and shot.height > 0:
            self.shot = (result.screen_width, result.screen_height, shot.width, shot.height)

    def image_size(self) -> tuple[int, int]:
        if self.shot is not None:
            return self.shot[2], self.shot[3]
        assert self.screen is not None
        return _fit(*self.screen, self.max_width, self.max_height)

    def _factors(self) -> tuple[float, float]:
        if self.shot is not None:
            sw, sh, iw, ih = self.shot
        else:
            assert self.screen is not None
            sw, sh = self.screen
            iw, ih = _fit(sw, sh, self.max_width, self.max_height)
        return sw / iw, sh / ih

    def to_screen(self, x: float, y: float) -> tuple[int, int]:
        assert self.screen is not None
        fx, fy = self._factors()
        w, h = self.screen
        return _clamp(round(x * fx), 0, w - 1), _clamp(round(y * fy), 0, h - 1)

    def to_image(self, x: int, y: int) -> tuple[int, int]:
        fx, fy = self._factors()
        iw, ih = self.image_size()
        return _clamp(round(x / fx), 0, iw - 1), _clamp(round(y / fy), 0, ih - 1)

    def region_to_screen(self, x0: float, y0: float, x1: float, y1: float):
        """Corners in image pixels → (x, y, width, height) on the screen."""
        assert self.screen is not None
        fx, fy = self._factors()
        w, h = self.screen
        left, right = sorted((x0 * fx, x1 * fx))
        top, bottom = sorted((y0 * fy, y1 * fy))
        left, top = _clamp(round(left), 0, w - 1), _clamp(round(top), 0, h - 1)
        right, bottom = _clamp(round(right), 0, w), _clamp(round(bottom), 0, h)
        if right <= left or bottom <= top:
            raise _BadInput("region needs x1 > x0 and y1 > y0, inside the screenshot")
        return left, top, right - left, bottom - top


# ── drivers ──────────────────────────────────────────────────────────


def _computer(client: Any):
    """`machines.computer` of a Boxd/AsyncBoxd client, or that namespace."""
    machines = getattr(client, "machines", None)
    return machines.computer if machines is not None else client


def _drive(steps: _Steps, computer: Any, machine: str) -> Any:
    try:
        call = next(steps)
        while True:
            name, kwargs = call
            try:
                result = getattr(computer, name)(machine, **kwargs)
            except BoxdError as err:
                call = steps.throw(err)
            else:
                call = steps.send(result)
    except StopIteration as done:
        return done.value


async def _adrive(steps: _Steps, computer: Any, machine: str) -> Any:
    try:
        call = next(steps)
        while True:
            name, kwargs = call
            try:
                result = await getattr(computer, name)(machine, **kwargs)
            except BoxdError as err:
                call = steps.throw(err)
            else:
                call = steps.send(result)
    except StopIteration as done:
        return done.value


class _Base:
    def __init__(
        self,
        client: Any,
        machine: str,
        *,
        max_width: int | None,
        max_height: int | None,
        settle_ms: int,
        format: str,
        quality: int | None,
        screen_size: tuple[int, int] | None,
        region: str | None = None,
    ) -> None:
        self.machine = machine
        self._screen_size = screen_size
        self._holding = False
        computer = _computer(client)
        self._computer = computer.in_region(region) if region else computer
        self._view = _View(max_width, max_height)
        self._options = ScreenshotOptions(
            format=format,
            quality=quality,
            max_width=max_width,
            max_height=max_height,
            delay_ms=settle_ms,
        )

    def _screenshot_kwargs(self, **extra: Any) -> dict[str, Any]:
        o = self._options
        return {
            "format": o.format,
            "quality": o.quality,
            "max_width": o.max_width,
            "max_height": o.max_height,
            "delay_ms": o.delay_ms,
            **extra,
        }

    def _holds_screen(self) -> _Steps:
        """Hold the screen at `screen_size` before the first action, so that
        someone opening the Desktop view mid-run doesn't resize it."""
        if self._screen_size is None or self._holding:
            return
        width, height = self._screen_size
        self._view.saw((yield ("set_screen_size", {"width": width, "height": height})))
        self._holding = True

    def _lets_go(self) -> _Steps:
        self._view.saw((yield ("release_screen_size", {})))
        self._holding = False

    def _knows_screen(self) -> _Steps:
        """Learn the screen's size (one cheap call) if no call has told us yet."""
        if self._view.screen is None:
            self._view.saw((yield ("cursor_position", {})))

    def _act(self, name: str, **kwargs: Any) -> _Steps:
        result = yield (name, kwargs)
        self._view.saw(result)
        return result


# ── Claude ───────────────────────────────────────────────────────────

_CLICKS = {
    "left_click": ("left", 1),
    "right_click": ("right", 1),
    "middle_click": ("middle", 1),
    "double_click": ("left", 2),
    "triple_click": ("left", 3),
}
_SCROLL = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
# Members whose call can carry the screenshot a following `screenshot` block
# asks for, saving a round trip.
_CARRIES_SCREENSHOT = frozenset(
    {
        *_CLICKS,
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
    }
)


def _check_claude_size(max_width: int, max_height: int) -> None:
    if max_width <= 0 or max_height <= 0:
        raise ValueError("max_width and max_height must be positive")
    if max(max_width, max_height) > _CLAUDE_MAX_EDGE:
        raise ValueError(f"Claude takes images up to {_CLAUDE_MAX_EDGE} px on the long edge")
    tiles = math.ceil(max_width / 28) * math.ceil(max_height / 28)
    if tiles > _CLAUDE_MAX_TILES:
        raise ValueError(
            f"{max_width}x{max_height} is {tiles} image tiles of 28x28; Claude takes up to "
            f"{_CLAUDE_MAX_TILES} (about 1280x800 is recommended)"
        )


def _image_block(shot: Screenshot | None) -> list[dict[str, Any]]:
    if shot is None:
        raise BoxdError("the machine answered without the screenshot")
    return [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": shot.mime_type, "data": shot.to_base64()},
        }
    ]


def _tool_result(block: Any, content: Any, *, is_error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "type": "tool_result",
        "tool_use_id": _get(block, "id"),
        "toolset_name": "computer",
        "content": content,
    }
    if is_error:
        result["is_error"] = True
    return result


class _ClaudeCore(_Base):
    def __init__(
        self,
        client: Any,
        machine: str,
        *,
        max_width: int = 1280,
        max_height: int = 800,
        settle_ms: int = 300,
        format: str = "png",
        quality: int | None = None,
        screen_size: tuple[int, int] | None = (1280, 800),
        region: str | None = None,
    ) -> None:
        _check_claude_size(max_width, max_height)
        super().__init__(
            client,
            machine,
            max_width=max_width,
            max_height=max_height,
            settle_ms=settle_ms,
            format=format,
            quality=quality,
            screen_size=screen_size,
            region=region,
        )

    @property
    def tool(self) -> dict[str, Any]:
        """The ``tools`` entry: ``{"type": "computer_toolset_20260801"}``.

        Add ``"configs"`` to it to turn members off (``{"zoom": {"enabled":
        False}}``)."""
        return {"type": CLAUDE_COMPUTER_TOOLSET}

    def _turn(self, content: Any) -> _Steps:
        blocks = [
            b
            for b in _items(content, "content")
            if _get(b, "type") == "tool_use" and _get(b, "toolset_name") == "computer"
        ]
        results: list[dict[str, Any]] = []
        if blocks:
            yield from self._holds_screen()
        failed = False
        i = 0
        while i < len(blocks):
            block = blocks[i]
            if failed:
                results.append(_tool_result(block, _NOT_EXECUTED, is_error=True))
                i += 1
                continue
            name = _get(block, "name")
            nxt = blocks[i + 1] if i + 1 < len(blocks) else None
            carry = (
                nxt is not None
                and name in _CARRIES_SCREENSHOT
                and _get(nxt, "name") == "screenshot"
            )
            try:
                content_out, result = yield from self._member(
                    name, _get(block, "input") or {}, carry
                )
            except _FATAL:
                raise
            except (_BadInput, BoxdError) as err:
                failed = True
                message = err.message if isinstance(err, BoxdError) else str(err)
                results.append(_tool_result(block, message, is_error=True))
                i += 1
                continue
            results.append(_tool_result(block, content_out))
            if carry:
                results.append(_tool_result(nxt, _image_block(result.screenshot)))
                i += 2
            else:
                i += 1
        return results

    def _member(self, name: str, inp: Any, carry: bool) -> _Steps:
        """Run one member; return (tool_result content, the call's result)."""
        if not isinstance(inp, Mapping):
            raise _BadInput(f"input must be an object, not {inp!r}")
        view = self._view
        if name == "screenshot":
            result = yield ("screenshot", self._screenshot_kwargs())
            view.saw_full(result)
            return _image_block(result.screenshot), result
        if name == "zoom":
            region = inp.get("region")
            if not isinstance(region, (list, tuple)) or len(region) != 4:
                raise _BadInput(f"region must be [x0, y0, x1, y1], not {region!r}")
            corners = [_number(v, "region") for v in region]
            yield from self._knows_screen()
            box = view.region_to_screen(*corners)
            result = yield from self._act("screenshot", **self._screenshot_kwargs(region=box))
            return _image_block(result.screenshot), result

        shot = self._options if carry else False
        if name in _CLICKS:
            button, count = _CLICKS[name]
            x, y = yield from self._point(inp, "coordinate")
            result = yield from self._act(
                "click",
                x=x,
                y=y,
                button=button,
                count=count,
                modifiers=self._modifiers(inp),
                screenshot=shot,
            )
        elif name == "left_click_drag":
            start = yield from self._point(inp, "start_coordinate", required=True)
            end = yield from self._point(inp, "coordinate", required=True)
            result = yield from self._act(
                "drag", path=[start, end], modifiers=self._modifiers(inp), screenshot=shot
            )
        elif name == "mouse_move":
            x, y = yield from self._point(inp, "coordinate", required=True)
            result = yield from self._act("move", x=x, y=y, screenshot=shot)
        elif name in ("left_mouse_down", "left_mouse_up"):
            x, y = yield from self._point(inp, "coordinate")
            method = "mouse_down" if name == "left_mouse_down" else "mouse_up"
            result = yield from self._act(method, x=x, y=y, button="left", screenshot=shot)
        elif name == "cursor_position":
            result = yield ("cursor_position", {"screenshot": shot})
            # In the coordinates of the screenshot that goes back with it,
            # when one does.
            if carry:
                view.saw_full(result)
            else:
                view.saw(result)
            x, y = view.to_image(result.cursor.x, result.cursor.y)
            return f"X={x}, Y={y}", result
        elif name == "scroll":
            direction = inp.get("scroll_direction")
            if direction not in _SCROLL:
                raise _BadInput("scroll_direction must be up, down, left or right")
            amount = inp.get("scroll_amount")
            if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
                raise _BadInput("scroll_amount must be a whole number of wheel clicks")
            sx, sy = _SCROLL[direction]
            x, y = yield from self._point(inp, "coordinate")
            result = yield from self._act(
                "scroll",
                x=x,
                y=y,
                dx=sx * amount,
                dy=sy * amount,
                modifiers=self._modifiers(inp),
                screenshot=shot,
            )
        elif name == "type":
            text = inp.get("text")
            if not isinstance(text, str):
                raise _BadInput("type needs text")
            result = yield from self._act("type", text=text, screenshot=shot)
        elif name == "key":
            keys = self._text(inp, "key")
            repeat = inp.get("repeat")
            if repeat is not None and (isinstance(repeat, bool) or not isinstance(repeat, int)):
                raise _BadInput("repeat must be a whole number")
            result = yield from self._act("key", keys=keys, repeat=repeat or 0, screenshot=shot)
        elif name == "hold_key":
            keys = self._text(inp, "hold_key")
            ms = self._duration_ms(inp)
            result = yield from self._act("key", keys=keys, hold_ms=ms, screenshot=shot)
        elif name == "wait":
            result = yield from self._act("wait", ms=self._duration_ms(inp), screenshot=shot)
        else:
            raise _BadInput(f"unknown computer action {name!r}")
        if carry:
            view.saw_full(result)
        return "OK", result

    def _point(self, inp: Mapping[str, Any], key: str, *, required: bool = False) -> _Steps:
        value = inp.get(key)
        if value is None:
            if required:
                raise _BadInput(f"{key} is required")
            return None, None
        x, y = _pair(value, key)
        yield from self._knows_screen()
        return self._view.to_screen(x, y)

    @staticmethod
    def _modifiers(inp: Mapping[str, Any]) -> str:
        text = inp.get("text")
        return text if isinstance(text, str) else ""

    @staticmethod
    def _text(inp: Mapping[str, Any], member: str) -> str:
        text = inp.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _BadInput(f"{member} needs text: a key or a combination like ctrl+s")
        return text

    @staticmethod
    def _duration_ms(inp: Mapping[str, Any]) -> int:
        seconds = _number(inp.get("duration"), "duration")
        if seconds < 0:
            raise _BadInput("duration can't be negative")
        return round(seconds * 1000)


class ClaudeComputer(_ClaudeCore):
    """Runs Claude's computer toolset on a machine's desktop.

    ::

        computer = ClaudeComputer(boxd, "my-machine")
        response = anthropic.messages.create(..., tools=[computer.tool], ...)
        messages.append({"role": "assistant", "content": response.content})
        results = computer.run(response.content)
        if results:
            messages.append({"role": "user", "content": results})

    `client` is a :class:`~boxd.Boxd` (or its ``machines.computer``).
    Screenshots are scaled down to fit ``max_width`` x ``max_height`` (default
    1280x800, within Claude's image limits), taken ``settle_ms`` after the
    action before them so the screen can catch up.

    The first action holds the screen at ``screen_size`` (default 1280x800),
    so that someone watching in the console doesn't resize it mid-run. Call
    :meth:`release` when the agent is done, or pass ``screen_size=None`` to
    leave the screen alone.
    """

    def run(self, content: Any) -> list[dict[str, Any]]:
        """Run the computer toolset's ``tool_use`` blocks in an assistant
        message's content (dicts or ``anthropic`` objects; other blocks are
        skipped), in order, and return one ``tool_result`` for each, for the
        next user message.

        The first failure stops the turn: that block's result is the error,
        and every later one is reported as not executed. A missing,
        inaccessible or unauthorized machine raises instead.
        """
        return _drive(self._turn(content), self._computer, self.machine)

    def release(self) -> None:
        """Let go of the screen: it follows whoever is viewing again."""
        _drive(self._lets_go(), self._computer, self.machine)


class AsyncClaudeComputer(_ClaudeCore):
    """Async twin of :class:`ClaudeComputer`, for an :class:`~boxd.AsyncBoxd`."""

    async def run(self, content: Any) -> list[dict[str, Any]]:
        return await _adrive(self._turn(content), self._computer, self.machine)

    async def release(self) -> None:
        await _adrive(self._lets_go(), self._computer, self.machine)


# ── OpenAI ───────────────────────────────────────────────────────────

_OPENAI_BUTTONS = {
    "left": "left",
    "right": "right",
    "wheel": "middle",
    "middle": "middle",
    "back": "back",
    "forward": "forward",
}


def _openai_key(key: Any) -> str:
    if not isinstance(key, str) or not key:
        raise ValueError(f"a key name must be a non-empty string, not {key!r}")
    if key == " ":
        return "space"
    # "A" is shift+a to the keyboard; a keypress of ["CTRL", "A"] means ctrl+a.
    if len(key) == 1 and key.isascii() and key.isalpha():
        return key.lower()
    return key


def _openai_combo(keys: Any) -> str:
    if isinstance(keys, str):
        keys = [keys]
    if not keys:
        return ""
    return "+".join(_openai_key(k) for k in keys)


class _OpenAICore(_Base):
    def __init__(
        self,
        client: Any,
        machine: str,
        *,
        max_width: int | None = 1600,
        max_height: int | None = 900,
        settle_ms: int = 300,
        format: str = "png",
        quality: int | None = None,
        scroll_pixels_per_click: int = 100,
        wait_ms: int = 2000,
        screen_size: tuple[int, int] | None = (1280, 800),
        region: str | None = None,
    ) -> None:
        if scroll_pixels_per_click <= 0:
            raise ValueError("scroll_pixels_per_click must be positive")
        super().__init__(
            client,
            machine,
            max_width=max_width,
            max_height=max_height,
            settle_ms=settle_ms,
            format=format,
            quality=quality,
            screen_size=screen_size,
            region=region,
        )
        self._scroll_px = scroll_pixels_per_click
        self._wait_ms = wait_ms

    @property
    def tool(self) -> dict[str, Any]:
        """The ``tools`` entry for OpenAI's computer tool: ``{"type": "computer"}``."""
        return {"type": "computer"}

    def _preview_tool(self) -> _Steps:
        yield from self._holds_screen()
        yield from self._knows_screen()
        width, height = self._view.image_size()
        return {
            "type": "computer_use_preview",
            "display_width": width,
            "display_height": height,
            "environment": "linux",
        }

    def _turn(self, output: Any, acknowledge: Any) -> _Steps:
        outputs: list[dict[str, Any]] = []
        for item in _items(output, "output"):
            if _get(item, "type") != "computer_call":
                continue
            call_id = _get(item, "call_id")
            checks = [_plain(c) for c in (_get(item, "pending_safety_checks") or [])]
            if checks:
                ok = acknowledge(checks) if callable(acknowledge) else bool(acknowledge)
                if not ok:
                    raise PendingSafetyCheckError(call_id, checks)
            yield from self._holds_screen()
            actions = _get(item, "actions")
            batched = actions is not None
            if not batched:
                single = _get(item, "action")
                actions = [single] if single is not None else []
            actions = list(actions)
            # The screenshot after the batch rides on its last action that
            # isn't one; screenshots before that are taken by nothing.
            last = max(
                (i for i, a in enumerate(actions) if _get(a, "type") != "screenshot"),
                default=-1,
            )
            result: ComputerActionResult | None = None
            for i in range(last + 1):
                if _get(actions[i], "type") == "screenshot":
                    continue
                result = yield from self._action(
                    actions[i], self._options if i == last else False
                )
            if result is None or result.screenshot is None:
                result = yield ("screenshot", self._screenshot_kwargs())
            self._view.saw_full(result)
            assert result.screenshot is not None
            screenshot: dict[str, Any] = {
                "type": "computer_screenshot",
                "image_url": result.screenshot.to_data_url(),
            }
            if batched:
                screenshot["detail"] = "original"
            out: dict[str, Any] = {
                "type": "computer_call_output",
                "call_id": call_id,
                "output": screenshot,
            }
            if checks:
                out["acknowledged_safety_checks"] = checks
            outputs.append(out)
        return outputs

    def _xy(self, action: Any, what: str) -> _Steps:
        x = _number(_get(action, "x"), f"{what} x")
        y = _number(_get(action, "y"), f"{what} y")
        yield from self._knows_screen()
        return self._view.to_screen(x, y)

    def _clicks(self, pixels: Any) -> int:
        if pixels is None:
            return 0
        pixels = _number(pixels, "scroll")
        if pixels == 0:
            return 0
        n = max(1, round(abs(pixels) / self._scroll_px))
        return int(math.copysign(min(n, 100), pixels))

    def _action(self, action: Any, shot: Any) -> _Steps:
        kind = _get(action, "type")
        mods = _openai_combo(_get(action, "keys")) if kind != "keypress" else ""
        if kind in ("click", "double_click"):
            button = _get(action, "button") or "left"
            if button not in _OPENAI_BUTTONS:
                raise ValueError(f"unknown mouse button {button!r}")
            x, y = yield from self._xy(action, kind)
            return (
                yield from self._act(
                    "click",
                    x=x,
                    y=y,
                    button=_OPENAI_BUTTONS[button],
                    count=2 if kind == "double_click" else 1,
                    modifiers=mods,
                    screenshot=shot,
                )
            )
        if kind == "drag":
            pairs = [_pair(p, "drag path point") for p in _get(action, "path") or []]
            yield from self._knows_screen()
            path = [self._view.to_screen(x, y) for x, y in pairs]
            return (yield from self._act("drag", path=path, modifiers=mods, screenshot=shot))
        if kind == "move":
            x, y = yield from self._xy(action, "move")
            return (yield from self._act("move", x=x, y=y, screenshot=shot))
        if kind == "scroll":
            x, y = yield from self._xy(action, "scroll")
            dx = self._clicks(_get(action, "scroll_x"))
            dy = self._clicks(_get(action, "scroll_y"))
            if dx == 0 and dy == 0:
                return (yield from self._act("move", x=x, y=y, screenshot=shot))
            return (
                yield from self._act(
                    "scroll", x=x, y=y, dx=dx, dy=dy, modifiers=mods, screenshot=shot
                )
            )
        if kind == "keypress":
            keys = _openai_combo(_get(action, "keys"))
            if not keys:
                raise ValueError("keypress needs keys")
            return (yield from self._act("key", keys=keys, screenshot=shot))
        if kind == "type":
            text = _get(action, "text")
            if not isinstance(text, str):
                raise ValueError("type needs text")
            return (yield from self._act("type", text=text, screenshot=shot))
        if kind == "wait":
            ms = _get(action, "ms")
            ms = self._wait_ms if not isinstance(ms, int) or isinstance(ms, bool) else ms
            return (yield from self._act("wait", ms=ms, screenshot=shot))
        raise ValueError(f"unknown computer action {kind!r}")


class OpenAIComputer(_OpenAICore):
    """Runs OpenAI's computer tool calls on a machine's desktop.

    ::

        computer = OpenAIComputer(boxd, "my-machine")
        response = openai.responses.create(..., tools=[computer.tool], ...)
        outputs = computer.run(response.output)
        if outputs:
            response = openai.responses.create(
                ..., previous_response_id=response.id, input=outputs
            )

    `client` is a :class:`~boxd.Boxd` (or its ``machines.computer``). Each
    ``computer_call`` runs its actions in order and answers with a screenshot
    taken ``settle_ms`` after the last one, scaled down to fit ``max_width`` x
    ``max_height`` (default 1600x900). Scroll distances in pixels become wheel
    clicks of ``scroll_pixels_per_click``, at least one; a ``wait`` waits
    ``wait_ms``. Held ``keys`` on a ``move`` are not supported and ignored.

    The first action holds the screen at ``screen_size`` (default 1280x800),
    so that someone watching in the console doesn't resize it mid-run. Call
    :meth:`release` when the agent is done, or pass ``screen_size=None`` to
    leave the screen alone.
    """

    def run(
        self,
        output: Any,
        *,
        acknowledge_safety_checks: bool | Callable[[list[dict[str, Any]]], bool] = False,
    ) -> list[dict[str, Any]]:
        """Run every ``computer_call`` in a response's ``output`` (dicts or
        ``openai`` objects; other items are skipped) and return one
        ``computer_call_output`` for each, for the next request's ``input``.

        A failed action raises, and nothing after it runs. A call with
        pending safety checks raises :class:`PendingSafetyCheckError` unless
        ``acknowledge_safety_checks`` is True or a function that returns True
        for them; acknowledged checks are sent back with the output.
        """
        return _drive(
            self._turn(output, acknowledge_safety_checks), self._computer, self.machine
        )

    def release(self) -> None:
        """Let go of the screen: it follows whoever is viewing again."""
        _drive(self._lets_go(), self._computer, self.machine)

    def preview_tool(self) -> dict[str, Any]:
        """The ``tools`` entry for the earlier ``computer_use_preview`` model,
        with the screenshot size as the display size (a call to the machine
        when the screen's size isn't known yet)."""
        return _drive(self._preview_tool(), self._computer, self.machine)


class AsyncOpenAIComputer(_OpenAICore):
    """Async twin of :class:`OpenAIComputer`, for an :class:`~boxd.AsyncBoxd`."""

    async def run(
        self,
        output: Any,
        *,
        acknowledge_safety_checks: bool | Callable[[list[dict[str, Any]]], bool] = False,
    ) -> list[dict[str, Any]]:
        return await _adrive(
            self._turn(output, acknowledge_safety_checks), self._computer, self.machine
        )

    async def preview_tool(self) -> dict[str, Any]:
        return await _adrive(self._preview_tool(), self._computer, self.machine)

    async def release(self) -> None:
        await _adrive(self._lets_go(), self._computer, self.machine)

