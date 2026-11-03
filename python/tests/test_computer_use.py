"""`boxd.computer_use`: Claude's computer toolset and OpenAI's computer tool,
run against a fake desktop that answers as the server does."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import grpc
import pytest
from pydantic import BaseModel, ConfigDict

from boxd._generated import api_pb2
from boxd.computer_use import (
    CLAUDE_COMPUTER_TOOLSET,
    AsyncClaudeComputer,
    AsyncOpenAIComputer,
    ClaudeComputer,
    OpenAIComputer,
    PendingSafetyCheckError,
)
from boxd.errors import APIConnectionError, BoxdError, NotFoundError, from_grpc_error
from boxd.resources.machines import AsyncMachines, Machines
from fakes import FakeRpcError

NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed."


def _fit(w, h, mw, mh):
    f = 1.0
    if mw:
        f = min(f, mw / w)
    if mh:
        f = min(f, mh / h)
    return (w, h) if f >= 1.0 else (max(1, round(w * f)), max(1, round(h * f)))


class FakeDesktop:
    """The server's `ComputerAction`: a screen, a pointer, and screenshots
    sized as the server sizes them. Records every request; `fail` maps a call
    index or an action name to the error that call raises."""

    def __init__(self, width=1600, height=900, *, fail=None):
        self.width, self.height = width, height
        self.cursor = (0, 0)
        self.requests: list[api_pb2.ComputerActionRequest] = []
        self.fail = dict(fail or {})

    def actions(self):
        return [r.WhichOneof("action") for r in self.requests]

    def last_request(self, action):
        return [r for r in self.requests if r.WhichOneof("action") == action][-1]

    def last(self, action):
        """The latest `action` message sent (`.click`, `.scroll`, ...)."""
        return getattr(self.last_request(action), action)

    def call(self, method, request, **_options):
        assert method == "ComputerAction"
        self.requests.append(request)
        which = request.WhichOneof("action")
        err = self.fail.pop(len(self.requests) - 1, None) or self.fail.get(which)
        if err is not None:
            raise err
        action = getattr(request, which)
        if which == "mouse_move":
            self.cursor = (action.to.x, action.to.y)
        elif which in ("click", "mouse_down", "mouse_up", "scroll") and action.HasField("at"):
            self.cursor = (action.at.x, action.at.y)
        elif which == "drag":
            self.cursor = (action.path[-1].x, action.path[-1].y)
        resp = api_pb2.ComputerActionResponse(
            screen_width=self.width,
            screen_height=self.height,
            cursor=api_pb2.ComputerPoint(x=self.cursor[0], y=self.cursor[1]),
        )
        if request.return_screenshot:
            o = request.screenshot_options
            if o.HasField("region"):
                w, h = o.region.width, o.region.height
            else:
                w, h = self.width, self.height
            iw, ih = _fit(w, h, o.max_width, o.max_height)
            resp.screenshot.CopyFrom(
                api_pb2.ComputerImage(
                    data=f"img {iw}x{ih} #{len(self.requests)}".encode(),
                    mime_type="image/png",
                    width=iw,
                    height=ih,
                )
            )
        return resp


class AsyncFakeDesktop(FakeDesktop):
    async def call(self, method, request, **options):
        return FakeDesktop.call(self, method, request, **options)


def client(desktop):
    return SimpleNamespace(machines=Machines(desktop))


def tool_use(name, input=None, id=None, toolset="computer"):
    block = {"type": "tool_use", "id": id or f"toolu_{name}", "name": name, "input": input or {}}
    if toolset:
        block["toolset_name"] = toolset
    return block


class ToolUseBlock(BaseModel):
    """Shaped like the anthropic SDK's block: `toolset_name` arrives as an
    extra field on an SDK that predates it."""

    model_config = ConfigDict(extra="allow")
    id: str
    input: dict
    name: str
    type: str = "tool_use"


def results_by_id(results):
    return {r["tool_use_id"]: r for r in results}


def image_of(result):
    (img,) = result["content"]
    assert img["type"] == "image"
    assert img["source"]["type"] == "base64"
    assert img["source"]["media_type"] == "image/png"
    return base64.b64decode(img["source"]["data"]).decode()


def claude(desktop=None, **kw):
    desktop = desktop or FakeDesktop()
    kw.setdefault("screen_size", None)
    return ClaudeComputer(client(desktop), "m", **kw), desktop


def screenshot_first(computer):
    """The opening screenshot: screen 1600x900 shown at 1280x720."""
    (r,) = computer.run([tool_use("screenshot")])
    assert image_of(r).startswith("img 1280x720")


# --- Claude: the toolset entry and its limits ---


def test_claude_tool_is_the_toolset_entry():
    computer, _ = claude()
    assert computer.tool == {"type": CLAUDE_COMPUTER_TOOLSET}
    assert CLAUDE_COMPUTER_TOOLSET == "computer_toolset_20260801"


@pytest.mark.parametrize(
    ("w", "h"),
    [(2600, 1000), (2576, 2576), (0, 800)],
)
def test_claude_refuses_screenshot_sizes_over_its_limits(w, h):
    with pytest.raises(ValueError):
        claude(max_width=w, max_height=h)


def test_claude_accepts_the_largest_16_9_size():
    claude(max_width=2576, max_height=1449)


# --- Claude: every member ---


def test_screenshot_is_scaled_to_fit_and_settles_first():
    computer, desktop = claude()
    (r,) = computer.run([tool_use("screenshot")])
    assert r == {
        "type": "tool_result",
        "tool_use_id": "toolu_screenshot",
        "toolset_name": "computer",
        "content": r["content"],
    }
    assert image_of(r).startswith("img 1280x720")
    o = desktop.requests[0].screenshot_options
    assert (o.max_width, o.max_height, o.delay_ms, o.format) == (1280, 800, 300, "png")


@pytest.mark.parametrize(
    ("name", "button", "count"),
    [
        ("left_click", "left", 1),
        ("right_click", "right", 1),
        ("middle_click", "middle", 1),
        ("double_click", "left", 2),
        ("triple_click", "left", 3),
    ],
)
def test_clicks_scale_coordinates_to_the_screen(name, button, count):
    computer, desktop = claude()
    screenshot_first(computer)
    (r,) = computer.run([tool_use(name, {"coordinate": [640, 360], "text": "ctrl"})])
    assert r["content"] == "OK" and "is_error" not in r
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)
    assert (click.button, click.count, click.modifiers) == (button, count, "ctrl")


def test_click_without_a_coordinate_clicks_where_the_pointer_is():
    computer, desktop = claude()
    computer.run([tool_use("left_click")])
    assert desktop.actions() == ["click"]
    assert not desktop.last("click").HasField("at")


def test_coordinates_round_and_clamp_to_the_screen():
    computer, desktop = claude()
    screenshot_first(computer)
    computer.run(
        [
            tool_use("mouse_move", {"coordinate": [1279, 719]}, id="a"),
            tool_use("mouse_move", {"coordinate": [5000, -20]}, id="b"),
            tool_use("mouse_move", {"coordinate": [0.4, 1.6]}, id="c"),
        ]
    )
    moves = [r.mouse_move.to for r in desktop.requests if r.WhichOneof("action") == "mouse_move"]
    assert [(p.x, p.y) for p in moves] == [(1599, 899), (1599, 0), (0, 2)]


def test_left_click_drag():
    computer, desktop = claude()
    screenshot_first(computer)
    (r,) = computer.run(
        [tool_use("left_click_drag", {"start_coordinate": [100, 80], "coordinate": [400, 240], "text": "shift"})]
    )
    assert r["content"] == "OK"
    drag = desktop.last("drag")
    assert [(p.x, p.y) for p in drag.path] == [(125, 100), (500, 300)]
    assert drag.modifiers == "shift"


def test_mouse_down_and_up_act_where_the_pointer_is():
    computer, desktop = claude()
    computer.run([tool_use("left_mouse_down", id="d"), tool_use("left_mouse_up", id="u")])
    assert desktop.actions() == ["mouse_down", "mouse_up"]
    for r in desktop.requests:
        b = getattr(r, r.WhichOneof("action"))
        assert not b.HasField("at") and b.button == "left"


def test_cursor_position_answers_in_screenshot_pixels():
    computer, desktop = claude()
    screenshot_first(computer)
    desktop.cursor = (800, 450)
    (r,) = computer.run([tool_use("cursor_position")])
    assert r["content"] == "X=640, Y=360"


def test_cursor_position_with_a_screenshot_answers_in_that_screenshots_pixels():
    computer, desktop = claude()
    screenshot_first(computer)
    # The screen grew (a Retina viewer connected) since Claude's last look.
    desktop.width, desktop.height = 2560, 1600
    desktop.cursor = (2000, 1200)
    r, shot = computer.run([tool_use("cursor_position", id="c"), tool_use("screenshot", id="s")])
    # The 1280x800 screenshot it rides with is half the screen's size.
    assert image_of(shot).startswith("img 1280x800")
    assert r["content"] == "X=1000, Y=600"


def test_mouse_down_and_up_take_a_coordinate():
    computer, desktop = claude()
    screenshot_first(computer)
    computer.run([tool_use("left_mouse_up", {"coordinate": [640, 360]})])
    assert (desktop.last("mouse_up").at.x, desktop.last("mouse_up").at.y) == (800, 450)


@pytest.mark.parametrize(
    ("direction", "dx", "dy"),
    [("up", 0, -3), ("down", 0, 3), ("left", -3, 0), ("right", 3, 0)],
)
def test_scroll_in_wheel_clicks(direction, dx, dy):
    computer, desktop = claude()
    screenshot_first(computer)
    scroll = {"coordinate": [640, 360], "scroll_direction": direction, "scroll_amount": 3, "text": "shift"}
    computer.run([tool_use("scroll", scroll)])
    s = desktop.last("scroll")
    assert (s.at.x, s.at.y, s.delta_x, s.delta_y, s.modifiers) == (800, 450, dx, dy, "shift")


def test_type_key_hold_key_wait():
    computer, desktop = claude()
    results = computer.run(
        [
            tool_use("type", {"text": "hello world"}, id="t"),
            tool_use("key", {"text": "ctrl+s"}, id="k"),
            tool_use("key", {"text": "Down", "repeat": 4}, id="r"),
            tool_use("hold_key", {"text": "shift", "duration": 1.5}, id="h"),
            tool_use("wait", {"duration": 2}, id="w"),
        ]
    )
    assert [r["content"] for r in results] == ["OK"] * 5
    t, k, r, h, w = desktop.requests
    assert t.type.text == "hello world"
    assert k.key == api_pb2.ComputerKey(keys="ctrl+s")
    assert r.key == api_pb2.ComputerKey(keys="Down", repeat=4)
    assert h.key == api_pb2.ComputerKey(keys="shift", hold_ms=1500)
    assert w.wait.ms == 2000


def test_zoom_returns_the_region_and_keeps_the_scale():
    computer, desktop = claude()
    screenshot_first(computer)
    (z,) = computer.run([tool_use("zoom", {"region": [0, 0, 640, 360]})])
    # The region in screen pixels, at full resolution (never scaled up).
    region = desktop.last_request("screenshot").screenshot_options.region
    assert (region.x, region.y, region.width, region.height) == (0, 0, 800, 450)
    assert image_of(z).startswith("img 800x450")
    # Claude still answers in the full screenshot's pixels.
    computer.run([tool_use("left_click", {"coordinate": [640, 360]})])
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


def test_zoom_of_a_big_region_is_scaled_to_the_usual_size():
    computer, desktop = claude()
    screenshot_first(computer)
    (z,) = computer.run([tool_use("zoom", {"region": [0, 0, 1280, 720]})])
    assert image_of(z).startswith("img 1280x720")
    o = desktop.last_request("screenshot").screenshot_options
    assert (o.region.width, o.region.height) == (1600, 900)


def test_a_new_screenshot_sets_the_scale_again():
    computer, desktop = claude()
    screenshot_first(computer)
    desktop.width, desktop.height = 1280, 720  # the screen changed size
    computer.run([tool_use("screenshot")])
    computer.run([tool_use("left_click", {"coordinate": [640, 360]})])
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (640, 360)


def test_coordinates_before_any_screenshot_use_the_screen_size():
    computer, desktop = claude()
    computer.run([tool_use("left_click", {"coordinate": [640, 360]})])
    # One cheap call to learn the screen's size, then the click.
    assert desktop.actions() == ["cursor_position", "click"]
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


def test_a_screen_that_fits_is_not_scaled():
    computer, desktop = claude(FakeDesktop(1024, 768))
    (r,) = computer.run([tool_use("screenshot")])
    assert image_of(r).startswith("img 1024x768")
    computer.run([tool_use("left_click", {"coordinate": [100, 200]})])
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (100, 200)


# --- Claude: batches ---


def test_a_batch_runs_in_order_and_a_trailing_screenshot_rides_on_the_last_action():
    computer, desktop = claude()
    screenshot_first(computer)
    results = computer.run(
        [
            {"type": "text", "text": "Let me search."},
            tool_use("left_click", {"coordinate": [400, 50]}, id="toolu_1"),
            tool_use("type", {"text": "boxd"}, id="toolu_2"),
            tool_use("key", {"text": "Return"}, id="toolu_3"),
            tool_use("screenshot", id="toolu_4"),
        ]
    )
    assert [r["tool_use_id"] for r in results] == ["toolu_1", "toolu_2", "toolu_3", "toolu_4"]
    assert all(r["toolset_name"] == "computer" for r in results)
    assert [r["content"] for r in results[:3]] == ["OK", "OK", "OK"]
    assert image_of(results[3]).startswith("img 1280x720")
    # Three calls, not four: the screenshot came back with the key press.
    assert desktop.actions()[1:] == ["click", "type", "key"]
    key = desktop.requests[-1]
    assert key.return_screenshot
    assert (key.screenshot_options.max_width, key.screenshot_options.delay_ms) == (1280, 300)


def test_the_first_failure_stops_the_batch():
    err = from_grpc_error(FakeRpcError(grpc.StatusCode.INVALID_ARGUMENT, "No such key name 'Retrun'"))
    computer, desktop = claude(FakeDesktop(fail={"key": err}))
    results = computer.run(
        [
            tool_use("type", {"text": "boxd"}, id="toolu_1"),
            tool_use("key", {"text": "Retrun"}, id="toolu_2"),
            tool_use("left_click", {"coordinate": [1, 1]}, id="toolu_3"),
            tool_use("screenshot", id="toolu_4"),
        ]
    )
    assert results[0]["content"] == "OK" and "is_error" not in results[0]
    assert results[1] == {
        "type": "tool_result",
        "tool_use_id": "toolu_2",
        "toolset_name": "computer",
        "content": "No such key name 'Retrun'",
        "is_error": True,
    }
    for r in results[2:]:
        assert r["is_error"] is True
        assert r["content"] == NOT_EXECUTED
        assert r["toolset_name"] == "computer"
    assert desktop.actions() == ["type", "key"]


def test_a_failed_action_with_a_trailing_screenshot_reports_both():
    down = from_grpc_error(FakeRpcError(grpc.StatusCode.UNAVAILABLE, "xdotool click: failed"))
    computer, _ = claude(FakeDesktop(fail={"click": down}))
    results = computer.run([tool_use("left_click", id="a"), tool_use("screenshot", id="b")])
    assert results[0]["is_error"] and results[0]["content"] == "xdotool click: failed"
    assert results[1]["is_error"] and results[1]["content"] == NOT_EXECUTED


@pytest.mark.parametrize(
    ("block", "message"),
    [
        (tool_use("scroll", {"scroll_direction": "sideways", "scroll_amount": 1}), "scroll_direction"),
        (tool_use("scroll", {"scroll_direction": "down"}), "scroll_amount"),
        (tool_use("left_click_drag", {"coordinate": [1, 1]}), "start_coordinate is required"),
        (tool_use("mouse_move", {"coordinate": "here"}), "coordinate must be [x, y]"),
        (tool_use("zoom", {"region": [1, 2, 3]}), "region must be"),
        (tool_use("zoom", {"region": [10, 10, 10, 50]}), "x1 > x0"),
        (tool_use("key", {}), "key needs text"),
        (tool_use("wait", {"duration": "soon"}), "duration must be a number"),
        (tool_use("teleport", {}), "unknown computer action 'teleport'"),
    ],
)
def test_malformed_input_is_reported_to_claude(block, message):
    computer, _ = claude()
    screenshot_first(computer)
    results = computer.run([block, tool_use("screenshot", id="after")])
    assert results[0]["is_error"] is True
    assert message in results[0]["content"]
    assert results[1]["content"] == NOT_EXECUTED


def test_blocks_that_are_not_the_computer_toolset_are_skipped():
    computer, desktop = claude()
    results = computer.run(
        [
            {"type": "thinking", "thinking": "", "signature": "x"},
            {"type": "text", "text": "hi"},
            tool_use("get_weather", {"city": "Paris"}, toolset=None),
            tool_use("screenshot", toolset="other"),
        ]
    )
    assert results == []
    assert desktop.requests == []


def test_sdk_objects_and_a_whole_message_are_accepted():
    computer, desktop = claude()
    message = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="Taking a look."),
            ToolUseBlock(id="toolu_a", name="screenshot", input={}, toolset_name="computer"),
            ToolUseBlock(
                id="toolu_b", name="left_click", input={"coordinate": [640, 360]}, toolset_name="computer"
            ),
        ]
    )
    results = computer.run(message)
    assert [r["tool_use_id"] for r in results] == ["toolu_a", "toolu_b"]
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


def test_a_machine_that_is_gone_raises():
    gone = NotFoundError("VM not found", code="not_found")
    computer, _ = claude(FakeDesktop(fail={"screenshot": gone}))
    with pytest.raises(NotFoundError):
        computer.run([tool_use("screenshot")])


def test_the_namespace_can_be_passed_directly():
    desktop = FakeDesktop()
    computer = ClaudeComputer(Machines(desktop).computer, "m", screen_size=None)
    computer.run([tool_use("screenshot")])
    assert desktop.requests[0].vm_id == "m"


def test_jpeg_screenshots():
    computer, desktop = claude(format="jpeg", quality=70)
    computer.run([tool_use("screenshot")])
    o = desktop.requests[0].screenshot_options
    assert (o.format, o.quality) == ("jpeg", 70)


async def test_async_claude():
    desktop = AsyncFakeDesktop()
    computer = AsyncClaudeComputer(
        SimpleNamespace(machines=AsyncMachines(desktop)), "m", screen_size=None
    )
    results = await computer.run(
        [
            tool_use("screenshot", id="s"),
            tool_use("left_click", {"coordinate": [640, 360]}, id="c"),
            tool_use("screenshot", id="s2"),
        ]
    )
    assert [r["tool_use_id"] for r in results] == ["s", "c", "s2"]
    assert desktop.actions() == ["screenshot", "click"]
    assert image_of(results[2]).startswith("img 1280x720")
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


# --- OpenAI ---


def openai(desktop=None, **kw):
    desktop = desktop or FakeDesktop()
    kw.setdefault("screen_size", None)
    return OpenAIComputer(client(desktop), "m", **kw), desktop


def computer_call(actions, call_id="call_1", checks=()):
    return {
        "type": "computer_call",
        "id": "cu_1",
        "call_id": call_id,
        "actions": actions,
        "pending_safety_checks": list(checks),
        "status": "completed",
    }


def image_url(output):
    assert output["type"] == "computer_call_output"
    shot = output["output"]
    assert shot["type"] == "computer_screenshot"
    prefix = "data:image/png;base64,"
    assert shot["image_url"].startswith(prefix)
    return base64.b64decode(shot["image_url"][len(prefix):]).decode()


def test_openai_tool():
    computer, _ = openai()
    assert computer.tool == {"type": "computer"}


def test_openai_first_call_is_a_screenshot():
    computer, desktop = openai()
    (out,) = computer.run([computer_call([{"type": "screenshot"}])])
    assert out["call_id"] == "call_1"
    assert out["output"]["detail"] == "original"
    assert image_url(out).startswith("img 1600x900")
    assert desktop.actions() == ["screenshot"]
    o = desktop.requests[0].screenshot_options
    assert (o.max_width, o.max_height, o.delay_ms) == (1600, 900, 300)


def test_openai_batch_runs_in_order_with_one_screenshot_at_the_end():
    computer, desktop = openai()
    computer.run([computer_call([{"type": "screenshot"}])])
    (out,) = computer.run(
        [
            {"type": "reasoning", "id": "rs_1", "summary": []},
            computer_call(
                [
                    {"type": "click", "button": "left", "x": 405, "y": 157},
                    {"type": "type", "text": "penguin"},
                    {"type": "keypress", "keys": ["ENTER"]},
                    {"type": "screenshot"},
                ],
                call_id="call_2",
            ),
        ]
    )
    assert out["call_id"] == "call_2"
    assert desktop.actions()[1:] == ["click", "type", "key"]
    assert [r.return_screenshot for r in desktop.requests[1:]] == [False, False, True]
    assert image_url(out).startswith("img 1600x900 #4")


@pytest.mark.parametrize(
    ("button", "expected"),
    [("left", "left"), ("right", "right"), ("wheel", "middle"), ("back", "back"), ("forward", "forward")],
)
def test_openai_click_buttons(button, expected):
    computer, desktop = openai()
    computer.run([computer_call([{"type": "click", "button": button, "x": 10, "y": 20}])])
    click = desktop.last("click")
    assert (click.button, click.count, click.at.x, click.at.y) == (expected, 1, 10, 20)


def test_openai_double_click_drag_move_with_held_keys():
    computer, desktop = openai()
    computer.run(
        [
            computer_call(
                [
                    {"type": "double_click", "x": 50, "y": 60, "keys": ["SHIFT"]},
                    {"type": "drag", "path": [{"x": 1, "y": 2}, {"x": 30, "y": 40}, [90, 100]], "keys": ["CTRL"]},
                    {"type": "move", "x": 7, "y": 8},
                ]
            )
        ]
    )
    d = desktop.last("click")
    assert (d.count, d.modifiers, d.at.x, d.at.y) == (2, "SHIFT", 50, 60)
    drag = desktop.last("drag")
    assert [(p.x, p.y) for p in drag.path] == [(1, 2), (30, 40), (90, 100)]
    assert drag.modifiers == "CTRL"
    assert desktop.last("mouse_move").to == api_pb2.ComputerPoint(x=7, y=8)


@pytest.mark.parametrize(
    ("sx", "sy", "dx", "dy"),
    [(0, 300, 0, 3), (0, -500, 0, -5), (0, 30, 0, 1), (-120, 0, -1, 0), (0, 99999, 0, 100)],
)
def test_openai_scroll_pixels_become_wheel_clicks(sx, sy, dx, dy):
    computer, desktop = openai()
    computer.run([computer_call([{"type": "scroll", "x": 100, "y": 200, "scroll_x": sx, "scroll_y": sy}])])
    s = desktop.last("scroll")
    assert (s.at.x, s.at.y, s.delta_x, s.delta_y) == (100, 200, dx, dy)


def test_openai_scroll_of_nothing_only_moves():
    computer, desktop = openai()
    computer.run([computer_call([{"type": "scroll", "x": 5, "y": 6, "scroll_x": 0, "scroll_y": 0}])])
    # (the first call learns the screen's size: no screenshot was taken yet)
    assert desktop.actions() == ["cursor_position", "mouse_move"]


def test_openai_scroll_step_is_configurable():
    computer, desktop = openai(scroll_pixels_per_click=50)
    computer.run([computer_call([{"type": "scroll", "x": 1, "y": 1, "scroll_x": 0, "scroll_y": 200}])])
    assert desktop.last("scroll").delta_y == 4


@pytest.mark.parametrize(
    ("keys", "combo"),
    [
        (["ENTER"], "ENTER"),
        (["CTRL", "A"], "CTRL+a"),
        (["CTRL", "SHIFT", "T"], "CTRL+SHIFT+t"),
        (["ARROWLEFT"], "ARROWLEFT"),
        ([" "], "space"),
        (["META", "c"], "META+c"),
    ],
)
def test_openai_keypress_is_one_combination(keys, combo):
    computer, desktop = openai()
    computer.run([computer_call([{"type": "keypress", "keys": keys}])])
    assert desktop.last("key").keys == combo


def test_openai_wait_and_type():
    computer, desktop = openai(wait_ms=1500)
    computer.run([computer_call([{"type": "type", "text": "hi"}, {"type": "wait"}])])
    assert desktop.last("type").text == "hi"
    w = desktop.last_request("wait")
    assert w.wait.ms == 1500 and w.return_screenshot


def test_openai_coordinates_scale_like_claudes():
    computer, desktop = openai(max_width=1280, max_height=800)
    (first,) = computer.run([computer_call([{"type": "screenshot"}])])
    assert image_url(first).startswith("img 1280x720")
    computer.run([computer_call([{"type": "click", "button": "left", "x": 640, "y": 360}])])
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


def test_openai_preview_shape():
    computer, desktop = openai(max_width=1280, max_height=800)
    assert computer.preview_tool() == {
        "type": "computer_use_preview",
        "display_width": 1280,
        "display_height": 720,
        "environment": "linux",
    }
    (out,) = computer.run(
        [{"type": "computer_call", "call_id": "c", "action": {"type": "click", "button": "left", "x": 640, "y": 360}}]
    )
    assert "detail" not in out["output"]
    assert image_url(out).startswith("img 1280x720")
    click = desktop.last("click")
    assert (click.at.x, click.at.y) == (800, 450)


def test_openai_pending_safety_checks_stop_unless_acknowledged():
    check = {"id": "sc_1", "code": "malicious_instructions", "message": "Suspicious page."}
    computer, desktop = openai()
    with pytest.raises(PendingSafetyCheckError) as caught:
        computer.run([computer_call([{"type": "screenshot"}], checks=[check])])
    assert caught.value.checks == [check]
    assert desktop.requests == []

    seen = []
    (out,) = computer.run(
        [computer_call([{"type": "screenshot"}], checks=[check])],
        acknowledge_safety_checks=lambda checks: seen.append(checks) or True,
    )
    assert seen == [[check]]
    assert out["acknowledged_safety_checks"] == [check]


def test_openai_a_failed_action_raises_and_stops():
    down = from_grpc_error(FakeRpcError(grpc.StatusCode.UNAVAILABLE, "xdotool type: failed"))
    computer, desktop = openai(FakeDesktop(fail={"type": down}))
    with pytest.raises(APIConnectionError):
        computer.run([computer_call([{"type": "type", "text": "x"}, {"type": "keypress", "keys": ["ENTER"]}])])
    assert desktop.actions() == ["type"]


def test_openai_unknown_action_raises():
    computer, _ = openai()
    with pytest.raises(ValueError, match="unknown computer action 'teleport'"):
        computer.run([computer_call([{"type": "teleport"}])])


def test_openai_sdk_objects_and_a_whole_response():
    computer, desktop = openai()
    response = SimpleNamespace(
        output=[
            SimpleNamespace(
                type="computer_call",
                call_id="call_9",
                actions=[SimpleNamespace(type="click", button="left", x=3, y=4, keys=None)],
                pending_safety_checks=[],
            )
        ]
    )
    (out,) = computer.run(response)
    assert out["call_id"] == "call_9"
    assert desktop.actions() == ["cursor_position", "click"]


async def test_async_openai():
    desktop = AsyncFakeDesktop()
    computer = AsyncOpenAIComputer(
        SimpleNamespace(machines=AsyncMachines(desktop)), "m", screen_size=None
    )
    assert (await computer.preview_tool())["display_width"] == 1600
    (out,) = await computer.run([computer_call([{"type": "move", "x": 1, "y": 1}])])
    assert image_url(out).startswith("img 1600x900")


def test_errors_are_boxd_errors():
    # The adapters let SDK errors through as they are.
    assert issubclass(APIConnectionError, BoxdError)


# --- Holding the screen ---


def _kinds(desktop):
    return [r.WhichOneof("action") for r in desktop.requests]


def test_claude_holds_the_screen_once_before_its_first_action():
    desktop = FakeDesktop()
    computer = ClaudeComputer(client(desktop), "m")
    computer.run([tool_use("screenshot")])
    computer.run([tool_use("screenshot")])
    assert _kinds(desktop) == ["set_screen_size", "screenshot", "screenshot"]
    first = desktop.requests[0].set_screen_size
    assert (first.width, first.height) == (1280, 800)


def test_a_turn_without_computer_actions_holds_nothing():
    desktop = FakeDesktop()
    assert ClaudeComputer(client(desktop), "m").run([{"type": "text", "text": "done"}]) == []
    assert OpenAIComputer(client(desktop), "m").run([{"type": "message"}]) == []
    assert desktop.requests == []


def test_the_size_can_be_chosen_or_left_alone():
    desktop = FakeDesktop()
    ClaudeComputer(client(desktop), "m", screen_size=(1024, 768)).run([tool_use("screenshot")])
    first = desktop.requests[0].set_screen_size
    assert (first.width, first.height) == (1024, 768)
    desktop = FakeDesktop()
    ClaudeComputer(client(desktop), "m", screen_size=None).run([tool_use("screenshot")])
    assert _kinds(desktop) == ["screenshot"]


def test_release_lets_go_and_the_next_action_holds_again():
    desktop = FakeDesktop()
    computer = ClaudeComputer(client(desktop), "m")
    computer.run([tool_use("screenshot")])
    computer.release()
    released = desktop.requests[-1].set_screen_size
    assert (released.width, released.height) == (0, 0)
    computer.run([tool_use("screenshot")])
    assert _kinds(desktop)[-2:] == ["set_screen_size", "screenshot"]


def test_openai_holds_the_screen_but_not_for_a_call_it_refuses():
    desktop = FakeDesktop()
    computer = OpenAIComputer(client(desktop), "m")
    refused = computer_call([{"type": "move", "x": 1, "y": 1}], checks=[{"id": "c", "code": "x"}])
    with pytest.raises(PendingSafetyCheckError):
        computer.run([refused])
    assert desktop.requests == []
    computer.run([computer_call([{"type": "move", "x": 1, "y": 1}])])
    assert _kinds(desktop)[0] == "set_screen_size"


async def test_async_adapters_hold_and_release():
    desktop = AsyncFakeDesktop()
    computer = AsyncClaudeComputer(SimpleNamespace(machines=AsyncMachines(desktop)), "m")
    await computer.run([tool_use("screenshot")])
    await computer.release()
    assert _kinds(desktop) == ["set_screen_size", "screenshot", "set_screen_size"]


def test_an_adapter_works_in_the_machines_region():
    from fakes import FakeTransport

    t = FakeTransport([api_pb2.ComputerActionResponse(screen_width=1280, screen_height=800)] * 3)
    computer = ClaudeComputer(Machines(t).computer, "m", region="nyc")
    computer.run([tool_use("screenshot")])
    assert set(t.regions) == {"nyc"}
