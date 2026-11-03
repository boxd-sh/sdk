"""`boxd.machines.computer` — screenshots, the mouse and the keyboard on a
machine's desktop, for computer-use agents.

The desktop is the one the console's Desktop view shows; it is started on
demand. Every call does one action and can take a screenshot after it
(``screenshot=True`` or :class:`~boxd.models.ScreenshotOptions`), so one step
of an agent loop is one round trip. Coordinates are screen pixels from the top
left, and every call answers with the screen's size and where the pointer is.

For Claude and OpenAI computer-use models, :mod:`boxd.computer_use` turns their
tool calls into these calls.
"""

from __future__ import annotations

import asyncio
import copy
import time
from collections.abc import Iterable, Sequence
from typing import Any

from .. import _mappers as m
from .. import _requests as req
from .._generated import api_pb2
from ..errors import BoxdError
from ..models import ComputerActionResult, ScreenshotFormat
from . import Namespace

ScreenshotArg = req.ScreenshotArg

# Actions that only look at the screen: sending one again is harmless, so the
# transport's usual retries apply. Everything else (a click, typing) is sent
# again only when it cannot have reached the machine.
# Safe to send twice. Setting a screen size ends in the same place however many
# times it runs.
_READ_ONLY = frozenset({"screenshot", "cursor_position", "set_screen_size"})

# Waits before sending an input action again, and the errors that mean it
# never reached the machine: the server could not open a session to the
# machine's agent, or the connection to the server was never made.
_RETRY_BACKOFF = (1.0, 3.0)
_NOT_SENT = ("cannot connect to VM agent", "failed to connect to all addresses")


def _retry_wait(request: api_pb2.ComputerActionRequest, err: BoxdError, attempt: int):
    if request.WhichOneof("action") in _READ_ONLY:
        return None  # the transport has already retried it
    if attempt >= len(_RETRY_BACKOFF) or err.code != "unavailable":
        return None
    if not err.message.startswith(_NOT_SENT):
        return None
    return _RETRY_BACKOFF[attempt]


def _call_options(request: api_pb2.ComputerActionRequest) -> dict[str, Any]:
    return {
        "extra_timeout": req.computer_action_seconds(request),
        "retry": request.WhichOneof("action") in _READ_ONLY,
    }


# Request builders shared by both namespaces.


def _screenshot(
    machine_id: str,
    *,
    format: ScreenshotFormat | str | None,
    quality: int | None,
    max_width: int | None,
    max_height: int | None,
    region: tuple[int, int, int, int] | None,
    delay_ms: int | None,
):
    options = {
        k: v
        for k, v in {
            "format": format,
            "quality": quality,
            "max_width": max_width,
            "max_height": max_height,
            "region": region,
            "delay_ms": delay_ms,
        }.items()
        if v is not None
    }
    return req.computer_action(
        machine_id, options, screenshot=api_pb2.ComputerScreenshot()
    )


def _click(machine_id, x, y, button, count, modifiers, screenshot):
    return req.computer_action(
        machine_id,
        screenshot,
        click=api_pb2.ComputerClick(
            at=req.computer_at(x, y),
            button=button,
            count=count,
            modifiers=req.computer_modifiers(modifiers),
        ),
    )


def _set_screen_size(machine_id, width, height, screenshot):
    return req.computer_action(
        machine_id,
        screenshot,
        set_screen_size=api_pb2.ComputerSetScreenSize(width=width, height=height),
    )


def _button(machine_id, which, x, y, button, screenshot):
    return req.computer_action(
        machine_id,
        screenshot,
        **{which: api_pb2.ComputerMouseButton(at=req.computer_at(x, y), button=button)},
    )


def _drag(machine_id, path, button, modifiers, screenshot):
    return req.computer_action(
        machine_id,
        screenshot,
        drag=api_pb2.ComputerDrag(
            path=[req.computer_point(p, "a drag path point") for p in path],
            button=button,
            modifiers=req.computer_modifiers(modifiers),
        ),
    )


def _scroll(machine_id, x, y, dx, dy, modifiers, screenshot):
    return req.computer_action(
        machine_id,
        screenshot,
        scroll=api_pb2.ComputerScroll(
            at=req.computer_at(x, y),
            delta_x=dx,
            delta_y=dy,
            modifiers=req.computer_modifiers(modifiers),
        ),
    )


# ── Sync ─────────────────────────────────────────────────────────────


class _InRegion(Namespace):
    """A namespace whose calls can be bound to a region: what the adapters use
    for a machine in another one. A call's own ``region=`` wins, except on
    ``screenshot``, whose ``region`` is the part of the screen to capture."""

    _region: str | None = None

    def in_region(self, region: str | None):
        if not region:
            return self
        bound = copy.copy(self)
        bound._region = region
        return bound


class Computer(_InRegion):
    """`boxd.machines.computer` — the machine's desktop: screenshots, mouse,
    keyboard.

    Every method takes the machine (id or name) first, does one action, and
    returns a :class:`~boxd.models.ComputerActionResult`. Pass
    ``screenshot=True`` (or :class:`~boxd.models.ScreenshotOptions`, or a dict
    of its fields) to any action to get a screenshot taken after it, in the
    same call.
    """

    def _act(
        self, request: api_pb2.ComputerActionRequest, region: str | None = None
    ) -> ComputerActionResult:
        region = region or self._region
        attempt = 0
        while True:
            try:
                return m.computer_action_result(
                    self._transport.call(
                        "ComputerAction", request, region=region, **_call_options(request)
                    )
                )
            except BoxdError as err:
                wait = _retry_wait(request, err, attempt)
                if wait is None:
                    raise
                time.sleep(wait)
                attempt += 1

    def screenshot(
        self,
        machine_id: str,
        *,
        format: ScreenshotFormat | str | None = None,
        quality: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        region: tuple[int, int, int, int] | None = None,
        delay_ms: int | None = None,
    ) -> ComputerActionResult:
        """The screen as an image (`result.screenshot`), PNG by default.

        `max_width`/`max_height` scale it down to fit, keeping its shape;
        `region` is `(x, y, width, height)` in screen pixels, for a closer
        look at part of the screen. Coordinates you act on stay screen
        pixels: scale them up when the image was scaled down.
        """
        return self._act(
            _screenshot(
                machine_id,
                format=format,
                quality=quality,
                max_width=max_width,
                max_height=max_height,
                region=region,
                delay_ms=delay_ms,
            ))

    def cursor_position(
        self, machine_id: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Where the pointer is (`result.cursor`), and the screen's size."""
        return self._act(
            req.computer_action(
                machine_id, screenshot, cursor_position=api_pb2.ComputerCursorPosition()
            ), region=region)

    def set_screen_size(
        self, machine_id: str, width: int, height: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Hold the screen at `width` x `height` (320x200 to 5120x2880) until
        :meth:`release_screen_size` or the desktop restarts. While it is held,
        someone watching in the console sees it scaled to fit instead of
        resizing it, so an agent's coordinates stay put."""
        return self._act(_set_screen_size(machine_id, width, height, screenshot), region=region)

    def release_screen_size(
        self, machine_id: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Let go of a held screen: it follows whoever is viewing again."""
        return self._act(_set_screen_size(machine_id, 0, 0, screenshot), region=region)

    def move(
        self, machine_id: str, x: int, y: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Move the pointer to `(x, y)` without clicking."""
        return self._act(
            req.computer_action(
                machine_id,
                screenshot,
                mouse_move=api_pb2.ComputerMouseMove(to=req.computer_point((x, y))),
            ), region=region)

    def click(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        count: int = 1,
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Click at `(x, y)`, or where the pointer is when both are omitted.

        `button` is "left", "right", "middle", "back" or "forward"; `count`
        2 is a double click, 3 a triple click. `modifiers` are keys held
        during the click: "shift", "ctrl", "alt", "super", or several joined
        with "+" (or given as a list).
        """
        return self._act(
            _click(machine_id, x, y, button, count, modifiers, screenshot), region=region)

    def mouse_down(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Press a mouse button (and keep it pressed), for a drag done step
        by step; `mouse_up` releases it."""
        return self._act(_button(machine_id, "mouse_down", x, y, button, screenshot), region=region)

    def mouse_up(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Release a mouse button."""
        return self._act(_button(machine_id, "mouse_up", x, y, button, screenshot), region=region)

    def drag(
        self,
        machine_id: str,
        path: Iterable[Any],
        *,
        button: str = "left",
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Press at the first point of `path`, move through the rest, release
        at the last. Points are `(x, y)` pairs (or anything with `.x`/`.y`);
        at least two."""
        return self._act(_drag(machine_id, path, button, modifiers, screenshot), region=region)

    def scroll(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        dx: int = 0,
        dy: int = 0,
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Turn the mouse wheel at `(x, y)` (or where the pointer is): `dy`
        clicks down (negative: up), `dx` clicks right (negative: left)."""
        return self._act(_scroll(machine_id, x, y, dx, dy, modifiers, screenshot), region=region)

    def type(
        self, machine_id: str, text: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Type `text` where the keyboard focus is, as a person would on a US
        keyboard layout."""
        return self._act(
            req.computer_action(machine_id, screenshot, type=api_pb2.ComputerType(text=text)), region=region)

    def key(
        self,
        machine_id: str,
        keys: str,
        *,
        repeat: int = 0,
        hold_ms: int = 0,
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        """Press a key or a combination: "Return", "ctrl+s", "alt+Tab", or
        several separated by spaces, pressed in turn.

        Names are X keysyms (as `xdotool` takes them) plus common aliases
        ("enter", "esc", "cmd", "arrowleft", "pageup"), case-insensitive.
        `repeat` presses them that many times; `hold_ms` holds one key or
        combination down that long instead.
        """
        return self._act(
            req.computer_action(
                machine_id,
                screenshot,
                key=api_pb2.ComputerKey(keys=keys, repeat=repeat, hold_ms=hold_ms),
            ), region=region)

    def wait(
        self, machine_id: str, ms: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        """Wait `ms` milliseconds (up to 300000), then answer; with
        `screenshot`, of the screen after the wait."""
        return self._act(
            req.computer_action(machine_id, screenshot, wait=api_pb2.ComputerWait(ms=ms)), region=region)


# ── Async ────────────────────────────────────────────────────────────


class AsyncComputer(_InRegion):
    """Async twin of :class:`Computer` — same methods, awaited."""

    async def _act(
        self, request: api_pb2.ComputerActionRequest, region: str | None = None
    ) -> ComputerActionResult:
        region = region or self._region
        attempt = 0
        while True:
            try:
                return m.computer_action_result(
                    await self._transport.call(
                        "ComputerAction", request, region=region, **_call_options(request)
                    )
                )
            except BoxdError as err:
                wait = _retry_wait(request, err, attempt)
                if wait is None:
                    raise
                await asyncio.sleep(wait)
                attempt += 1

    async def screenshot(
        self,
        machine_id: str,
        *,
        format: ScreenshotFormat | str | None = None,
        quality: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        region: tuple[int, int, int, int] | None = None,
        delay_ms: int | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            _screenshot(
                machine_id,
                format=format,
                quality=quality,
                max_width=max_width,
                max_height=max_height,
                region=region,
                delay_ms=delay_ms,
            ))

    async def cursor_position(
        self, machine_id: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(
            req.computer_action(
                machine_id, screenshot, cursor_position=api_pb2.ComputerCursorPosition()
            ), region=region)

    async def set_screen_size(
        self, machine_id: str, width: int, height: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(_set_screen_size(machine_id, width, height, screenshot), region=region)

    async def release_screen_size(
        self, machine_id: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(_set_screen_size(machine_id, 0, 0, screenshot), region=region)

    async def move(
        self, machine_id: str, x: int, y: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(
            req.computer_action(
                machine_id,
                screenshot,
                mouse_move=api_pb2.ComputerMouseMove(to=req.computer_point((x, y))),
            ), region=region)

    async def click(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        count: int = 1,
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            _click(machine_id, x, y, button, count, modifiers, screenshot), region=region)

    async def mouse_down(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            _button(machine_id, "mouse_down", x, y, button, screenshot), region=region)

    async def mouse_up(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        button: str = "left",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            _button(machine_id, "mouse_up", x, y, button, screenshot), region=region)

    async def drag(
        self,
        machine_id: str,
        path: Iterable[Any],
        *,
        button: str = "left",
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(_drag(machine_id, path, button, modifiers, screenshot), region=region)

    async def scroll(
        self,
        machine_id: str,
        x: int | None = None,
        y: int | None = None,
        *,
        dx: int = 0,
        dy: int = 0,
        modifiers: str | Sequence[str] = "",
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            _scroll(machine_id, x, y, dx, dy, modifiers, screenshot), region=region)

    async def type(
        self, machine_id: str, text: str, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(
            req.computer_action(machine_id, screenshot, type=api_pb2.ComputerType(text=text)), region=region)

    async def key(
        self,
        machine_id: str,
        keys: str,
        *,
        repeat: int = 0,
        hold_ms: int = 0,
        screenshot: ScreenshotArg = False, region: str | None = None,
    ) -> ComputerActionResult:
        return await self._act(
            req.computer_action(
                machine_id,
                screenshot,
                key=api_pb2.ComputerKey(keys=keys, repeat=repeat, hold_ms=hold_ms),
            ), region=region)

    async def wait(
        self, machine_id: str, ms: int, *, screenshot: ScreenshotArg = False, region: str | None = None
    ) -> ComputerActionResult:
        return await self._act(
            req.computer_action(machine_id, screenshot, wait=api_pb2.ComputerWait(ms=ms)), region=region)
