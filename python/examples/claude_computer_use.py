# /// script
# requires-python = ">=3.10"
# dependencies = ["boxd", "anthropic"]
# ///
"""Claude computer use on a boxd machine.

Claude looks at the machine's desktop and works the mouse and keyboard until
the task is done:

    export BOXD_API_KEY=bxd_...   # plus an Anthropic credential (ANTHROPIC_API_KEY, or `ant auth login`)
    uv run claude_computer_use.py "Search Wikipedia for the Eiffel Tower and tell me its height"

It creates a machine, opens a browser on its desktop, and deletes the machine
at the end; pass --machine NAME to use one of yours instead (it is kept). Open
the Desktop link it prints to watch along.
"""

from __future__ import annotations

import argparse
import json

import anthropic

from boxd import Boxd
from boxd.computer_use import ClaudeComputer

MODEL = "claude-opus-5-5"
SYSTEM = (
    "You are using a Linux desktop through the computer tool. A web browser is open on it. "
    "Start with a screenshot. When the task is done, give the answer and stop using the tool."
)


def run(boxd: Boxd, machine: str, task: str, max_turns: int) -> None:
    client = anthropic.Anthropic()
    # Holds the screen at 1280x800 from the first action, and shows it to Claude
    # at that size.
    computer = ClaudeComputer(boxd, machine)
    messages: list = [{"role": "user", "content": task}]
    usage = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}

    for turn in range(1, max_turns + 1):
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            output_config={"effort": "medium"},
            # A request the safety classifiers decline is retried on a
            # fallback model, server-side.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            # Every turn sends the conversation so far, screenshots included:
            # cache it.
            cache_control={"type": "ephemeral"},
            system=SYSTEM,
            tools=[computer.tool],
            messages=messages,
        ) as stream:
            response = stream.get_final_message()

        u = response.usage
        usage["input"] += u.input_tokens
        usage["cache_read"] += u.cache_read_input_tokens or 0
        usage["cache_write"] += u.cache_creation_input_tokens or 0
        usage["output"] += u.output_tokens

        # Keep the content exactly as it came, earlier screenshots and all.
        messages.append({"role": "assistant", "content": response.content})
        for block in response.content:
            if block.type == "text":
                print(block.text)
            elif block.type == "tool_use":
                print(f"  [{turn}] {block.name} {json.dumps(block.input)}")

        if response.stop_reason == "refusal":
            details = response.stop_details
            print(f"Claude declined ({details.category if details else 'no category'}).")
            break
        if response.stop_reason == "max_tokens":
            print("The response hit max_tokens; stopping.")
            break
        if response.stop_reason == "pause_turn":
            continue  # resume the same turn

        results = computer.run(response.content)
        if not results:
            break  # no computer actions: Claude is done
        messages.append({"role": "user", "content": results})
    else:
        print(f"Stopped after {max_turns} turns.")

    # Done: the screen follows whoever is watching again.
    computer.release()
    print(
        f"Tokens: {usage['input']} input, {usage['cache_read']} cache read, "
        f"{usage['cache_write']} cache write, {usage['output']} output"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("task", help="what Claude should do")
    parser.add_argument("--machine", help="use this machine (kept) instead of a new one")
    parser.add_argument("--url", default="about:blank", help="page to open in the browser first")
    parser.add_argument("--max-turns", type=int, default=30)
    args = parser.parse_args()

    with Boxd() as boxd:
        created = None
        machine = args.machine
        if machine is None:
            created = boxd.machines.create()
            boxd.machines.wait_until_ready(created.id)
            machine = created.id
        try:
            print("Desktop:", boxd.machines.get(machine).access.desktop_url)
            opened = boxd.machines.exec(machine, ["agent-browser", "open", args.url], timeout=120)
            if opened.exit_code != 0:
                # Without a browser Claude would only ever see an empty desktop.
                raise SystemExit(f"could not open the browser: {opened.stderr or opened.stdout}")
            run(boxd, machine, args.task, args.max_turns)
        finally:
            if created is not None:
                boxd.machines.delete(created.id)


if __name__ == "__main__":
    main()
