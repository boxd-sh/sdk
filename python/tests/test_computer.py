"""`machines.computer`: what goes on the wire, what comes back, the client's
deadline, and which failures are sent again."""

from __future__ import annotations

import grpc
import pytest

from boxd import ComputerActionResult, ComputerPoint, Screenshot, ScreenshotOptions
from boxd._generated import api_pb2
from boxd._transport import AsyncTransport, SyncTransport
from boxd.errors import APIConnectionError, APIStatusError, from_grpc_error
from boxd.resources.machines import AsyncMachines, Machines
from fakes import (
    FakeAsyncCredentials,
    FakeAsyncTransport,
    FakeCall,
    FakeCredentials,
    FakeRpcError,
    FakeStub,
    FakeTransport,
)


def response(*, screenshot=None, cursor=(10, 20), screen=(1600, 900)):
    r = api_pb2.ComputerActionResponse(
        screen_width=screen[0],
        screen_height=screen[1],
        cursor=api_pb2.ComputerPoint(x=cursor[0], y=cursor[1]),
    )
    if screenshot is not None:
        r.screenshot.CopyFrom(screenshot)
    return r


PNG = api_pb2.ComputerImage(data=b"\x89PNG...", mime_type="image/png", width=1280, height=720)


def computer(*responses):
    t = FakeTransport(list(responses) or [response()])
    return Machines(t).computer, t


def sent(t, i=0) -> api_pb2.ComputerActionRequest:
    method, request = t.calls[i]
    assert method == "ComputerAction"
    return request


# --- the request ---


def test_screenshot_always_asks_for_one():
    c, t = computer(response(screenshot=PNG))
    result = c.screenshot("m")
    r = sent(t)
    assert r.vm_id == "m"
    assert r.WhichOneof("action") == "screenshot"
    assert r.return_screenshot
    assert r.screenshot_options == api_pb2.ComputerScreenshotOptions(format="png")
    assert result.screenshot is not None


def test_screenshot_options_reach_the_wire():
    c, t = computer(response(screenshot=PNG))
    c.screenshot(
        "m",
        format="jpeg",
        quality=70,
        max_width=1280,
        max_height=800,
        region=(100, 200, 400, 300),
        delay_ms=250,
    )
    assert sent(t).screenshot_options == api_pb2.ComputerScreenshotOptions(
        format="jpeg",
        quality=70,
        max_width=1280,
        max_height=800,
        region=api_pb2.ComputerRegion(x=100, y=200, width=400, height=300),
        delay_ms=250,
    )


def test_an_action_takes_no_screenshot_unless_asked():
    c, t = computer()
    result = c.click("m", 5, 6)
    r = sent(t)
    assert not r.return_screenshot
    assert not r.HasField("screenshot_options")
    assert result.screenshot is None


@pytest.mark.parametrize(
    ("arg", "expected"),
    [
        (True, api_pb2.ComputerScreenshotOptions(format="png")),
        (
            ScreenshotOptions(format="webp", quality=60, max_width=1024, delay_ms=300),
            api_pb2.ComputerScreenshotOptions(
                format="webp", quality=60, max_width=1024, delay_ms=300
            ),
        ),
        (
            {"max_width": 1280, "max_height": 800},
            api_pb2.ComputerScreenshotOptions(format="png", max_width=1280, max_height=800),
        ),
    ],
)
def test_screenshot_argument_forms(arg, expected):
    c, t = computer(response(screenshot=PNG))
    c.type("m", "hi", screenshot=arg)
    r = sent(t)
    assert r.return_screenshot
    assert r.screenshot_options == expected


def test_a_bad_screenshot_argument_is_refused_before_sending():
    c, t = computer()
    with pytest.raises(TypeError):
        c.click("m", screenshot="yes")
    assert t.calls == []


def test_click():
    c, t = computer()
    c.click("m", 30, 40, button="right", count=2, modifiers="ctrl+shift")
    assert sent(t).click == api_pb2.ComputerClick(
        at=api_pb2.ComputerPoint(x=30, y=40), button="right", count=2, modifiers="ctrl+shift"
    )


def test_click_where_the_pointer_is():
    c, t = computer()
    c.click("m")
    click = sent(t).click
    assert not click.HasField("at")
    assert click.button == "left" and click.count == 1


def test_modifiers_as_a_list():
    c, t = computer()
    c.scroll("m", dy=3, modifiers=["ctrl", "shift"])
    assert sent(t).scroll.modifiers == "ctrl+shift"


@pytest.mark.parametrize("xy", [{"x": 5}, {"y": 5}])
def test_half_a_point_is_refused(xy):
    c, t = computer()
    with pytest.raises(ValueError, match="both x and y"):
        c.click("m", **xy)
    assert t.calls == []


def test_move():
    c, t = computer()
    c.move("m", 7, 8)
    assert sent(t).mouse_move.to == api_pb2.ComputerPoint(x=7, y=8)


def test_mouse_down_and_up():
    c, t = computer(response(), response())
    c.mouse_down("m", 1, 2, button="middle")
    c.mouse_up("m")
    assert sent(t, 0).mouse_down == api_pb2.ComputerMouseButton(
        at=api_pb2.ComputerPoint(x=1, y=2), button="middle"
    )
    up = sent(t, 1).mouse_up
    assert not up.HasField("at") and up.button == "left"


def test_drag_takes_pairs_and_points():
    c, t = computer()
    c.drag("m", [(0, 0), ComputerPoint(x=50, y=60), [100, 120]], modifiers="shift")
    drag = sent(t).drag
    assert [(p.x, p.y) for p in drag.path] == [(0, 0), (50, 60), (100, 120)]
    assert drag.button == "left" and drag.modifiers == "shift"


def test_drag_refuses_a_point_that_is_not_one():
    c, _t = computer()
    with pytest.raises(TypeError, match="drag path point"):
        c.drag("m", [(0, 0), 5])


def test_scroll():
    c, t = computer()
    c.scroll("m", 10, 20, dx=-2, dy=5)
    assert sent(t).scroll == api_pb2.ComputerScroll(
        at=api_pb2.ComputerPoint(x=10, y=20), delta_x=-2, delta_y=5
    )


def test_type_key_wait_cursor():
    c, t = computer(response(), response(), response(), response())
    c.type("m", "hello")
    c.key("m", "ctrl+s", repeat=3)
    c.key("m", "shift", hold_ms=1500)
    c.wait("m", 2000)
    assert sent(t, 0).type.text == "hello"
    assert sent(t, 1).key == api_pb2.ComputerKey(keys="ctrl+s", repeat=3)
    assert sent(t, 2).key == api_pb2.ComputerKey(keys="shift", hold_ms=1500)
    assert sent(t, 3).wait.ms == 2000


def test_set_screen_size_holds_and_release_lets_go():
    held = api_pb2.ComputerActionResponse(screen_width=1280, screen_height=800, screen_held=True)
    c, t = computer(held, response())
    result = c.set_screen_size("m", 1280, 800)
    assert sent(t, 0).set_screen_size == api_pb2.ComputerSetScreenSize(width=1280, height=800)
    assert result.screen_held is True
    result = c.release_screen_size("m")
    assert sent(t, 1).set_screen_size == api_pb2.ComputerSetScreenSize(width=0, height=0)
    assert sent(t, 1).WhichOneof("action") == "set_screen_size"
    assert result.screen_held is False


def test_a_call_names_its_region():
    c, t = computer(response(), response())
    c.click("m", 1, 2, region="nyc")
    # A screenshot's own `region` is the part of the screen to capture.
    c.in_region("nyc").screenshot("m", region=(1, 2, 3, 4))
    assert t.regions == ["nyc", "nyc"]
    assert sent(t, 1).screenshot_options.region.width == 3
    # The transport's timeout and retry settings still reach it.
    assert t.call_options[0]["retry"] is False


def test_a_namespace_bound_to_a_region_and_a_call_that_names_another():
    c, t = computer(response(), response(), response())
    bound = c.in_region("nyc")
    bound.click("m", 1, 2)
    bound.click("m", 1, 2, region="fra")
    c.click("m", 1, 2)
    assert t.regions == ["nyc", "fra", None]


def test_cursor_position():
    c, t = computer(response(cursor=(512, 384)))
    result = c.cursor_position("m")
    assert sent(t).WhichOneof("action") == "cursor_position"
    assert result.cursor == ComputerPoint(x=512, y=384)


# --- the result ---


def test_result_carries_screen_cursor_and_screenshot():
    c, _t = computer(response(screenshot=PNG, cursor=(3, 4)))
    result = c.screenshot("m")
    assert result == ComputerActionResult(
        screen_width=1600,
        screen_height=900,
        cursor=ComputerPoint(x=3, y=4),
        screenshot=Screenshot(data=b"\x89PNG...", mime_type="image/png", width=1280, height=720),
    )


def test_screenshot_helpers_and_repr():
    shot = Screenshot(data=b"abc", mime_type="image/jpeg", width=2, height=1)
    assert shot.to_base64() == "YWJj"
    assert shot.to_data_url() == "data:image/jpeg;base64,YWJj"
    assert "abc" not in repr(shot)  # image bytes stay out of logs


# --- the client's deadline and retries ---


def test_quick_actions_keep_the_default_deadline_and_input_is_sent_once():
    c, t = computer()
    c.click("m", 1, 1)
    assert t.call_options == [{"extra_timeout": 0.0, "retry": False}]


def test_looking_is_retried_by_the_transport():
    c, t = computer(response(screenshot=PNG), response())
    c.screenshot("m")
    c.cursor_position("m")
    assert [o["retry"] for o in t.call_options] == [True, True]


def test_long_actions_stretch_the_deadline():
    c, t = computer(response(screenshot=PNG), *[response() for _ in range(4)])
    c.wait("m", 120_000, screenshot={"delay_ms": 500})
    c.key("m", "shift", hold_ms=10_000)
    c.type("m", "x" * 1000)
    # Every press counts: two combinations, twice.
    c.key("m", "ctrl+a Delete", repeat=2)
    # Each segment of a drag is up to 20 small moves.
    c.drag("m", [(1, 1), (2, 2), (3, 3)])
    extra = [o["extra_timeout"] for o in t.call_options]
    assert extra[0] == pytest.approx(120.5)
    assert extra[1] == pytest.approx(10.04)
    assert extra[2] == pytest.approx(30.0)
    assert extra[3] == pytest.approx(0.16)
    assert extra[4] == pytest.approx(1.0)


def _unavailable(details):
    return from_grpc_error(FakeRpcError(grpc.StatusCode.UNAVAILABLE, details))


def test_an_action_that_never_reached_the_machine_is_sent_again(monkeypatch):
    slept = []
    monkeypatch.setattr("boxd.resources.computer.time.sleep", slept.append)
    c, t = computer(
        _unavailable("cannot connect to VM agent: agent at 192.0.2.10:4000 refused"),
        response(),
    )
    c.type("m", "hello")
    assert len(t.calls) == 2
    assert slept == [1.0]


def test_an_action_that_may_have_run_is_not_sent_again(monkeypatch):
    monkeypatch.setattr("boxd.resources.computer.time.sleep", lambda _s: None)
    c, t = computer(_unavailable("xdotool type: failed"), response())
    with pytest.raises(APIConnectionError, match="xdotool"):
        c.type("m", "hello")
    assert len(t.calls) == 1


def test_resending_gives_up(monkeypatch):
    monkeypatch.setattr("boxd.resources.computer.time.sleep", lambda _s: None)
    down = _unavailable("cannot connect to VM agent: timed out")
    c, t = computer(down, down, down, response())
    with pytest.raises(APIConnectionError):
        c.click("m", 1, 1)
    assert len(t.calls) == 3


def test_a_refused_request_surfaces_as_the_servers_error():
    err = from_grpc_error(
        FakeRpcError(grpc.StatusCode.INVALID_ARGUMENT, "unknown button \"wheel\"")
    )
    c, t = computer(err)
    with pytest.raises(APIStatusError) as caught:
        c.click("m", 1, 1, button="wheel")
    assert caught.value.code == "invalid_argument"
    assert "wheel" in caught.value.message
    assert len(t.calls) == 1


# --- the transport options it relies on ---


class _Recording:
    """A stub method that records each attempt's deadline."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.timeouts: list = []

    def with_call(self, request, timeout=None, metadata=None):
        self.timeouts.append(timeout)
        item = self.outcomes.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item, FakeCall()


def _sync_transport(outcomes, monkeypatch):
    method = _Recording(outcomes)
    t = SyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    t._stub = FakeStub(ComputerAction=method)
    monkeypatch.setattr("boxd._transport.time.sleep", lambda _s: None)
    return t, method


def test_transport_retry_false_sends_once(monkeypatch):
    t, method = _sync_transport(
        [FakeRpcError(grpc.StatusCode.UNAVAILABLE)] * 3, monkeypatch
    )
    with pytest.raises(APIConnectionError):
        t.call("ComputerAction", api_pb2.ComputerActionRequest(), retry=False)
    assert len(method.timeouts) == 1


def test_transport_extra_timeout_adds_to_the_deadline(monkeypatch):
    t, method = _sync_transport([response()], monkeypatch)
    t.call("ComputerAction", api_pb2.ComputerActionRequest(), extra_timeout=2.5)
    assert method.timeouts == [3.5]


async def test_async_transport_honours_both(monkeypatch):
    async def no_sleep(_s):
        return None

    monkeypatch.setattr("boxd._transport.asyncio.sleep", no_sleep)
    seen = []

    class Call:
        def __init__(self, outcome):
            self.outcome = outcome

        def __await__(self):
            async def go():
                if isinstance(self.outcome, BaseException):
                    raise self.outcome
                return self.outcome

            return go().__await__()

        async def initial_metadata(self):
            return []

    def method(request, timeout=None, metadata=None):
        seen.append(timeout)
        return Call(outcomes.pop(0))

    outcomes = [
        grpc.aio.AioRpcError(
            code=grpc.StatusCode.UNAVAILABLE,
            initial_metadata=grpc.aio.Metadata(),
            trailing_metadata=grpc.aio.Metadata(),
            details="down",
        ),
        response(),
    ]
    t = AsyncTransport(
        base_url="http://localhost:9443",
        credentials=FakeAsyncCredentials(),
        timeout=1.0,
        max_retries=2,
    )
    t._stub = FakeStub(ComputerAction=method)
    with pytest.raises(APIConnectionError):
        await t.call(
            "ComputerAction", api_pb2.ComputerActionRequest(), extra_timeout=1.0, retry=False
        )
    assert seen == [2.0]


# --- async ---


async def test_async_twin(monkeypatch):
    t = FakeAsyncTransport([response(screenshot=PNG), response()])
    c = AsyncMachines(t).computer
    result = await c.click("m", 3, 4, screenshot=True)
    assert result.screenshot is not None
    await c.key("m", "Return")
    assert t.calls[0][1].click.at == api_pb2.ComputerPoint(x=3, y=4)
    assert t.calls[1][1].key.keys == "Return"
    assert t.call_options[0] == {"extra_timeout": 0.0, "retry": False}


async def test_async_resends_an_action_that_never_reached_the_machine(monkeypatch):
    slept = []

    async def fake_sleep(s):
        slept.append(s)

    monkeypatch.setattr("boxd.resources.computer.asyncio.sleep", fake_sleep)
    t = FakeAsyncTransport(
        [_unavailable("cannot connect to VM agent: refused"), response()]
    )
    await AsyncMachines(t).computer.move("m", 1, 2)
    assert len(t.calls) == 2 and slept == [1.0]
