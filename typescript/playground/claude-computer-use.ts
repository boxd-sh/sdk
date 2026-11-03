/**
 * Claude computer use on a machine's desktop: Claude looks at screenshots
 * and drives the mouse and keyboard until the task is done.
 *
 *   bun run playground/claude-computer-use.ts <machine> "<task>"
 *
 * Needs a running machine you own, and Claude API credentials
 * (`ANTHROPIC_API_KEY`, or an `ant auth login` profile). Watch it work in the
 * console: the machine's Desktop view. MAX_TURNS caps the requests (default 15).
 */
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeComputer } from "../src/index.js";
import { client } from "./_common.js";

const [machine, ...words] = process.argv.slice(2);
const task = words.join(" ");
if (!machine || !task) {
  console.error('usage: bun run playground/claude-computer-use.ts <machine> "<task>"');
  process.exit(2);
}
const maxTurns = Number(process.env.MAX_TURNS ?? 15);

const boxd = client();
const anthropic = new Anthropic();
const computer = new ClaudeComputer(boxd, machine);

const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: task }];
try {
  for (let turn = 1; ; turn++) {
    if (turn > maxTurns) {
      console.log(`\nstopped after ${maxTurns} turns`);
      break;
    }
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // A request the safety classifiers decline is retried on a fallback
      // model, server-side.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Every turn sends the conversation so far, screenshots included:
      // cache it.
      cache_control: { type: "ephemeral" },
      tools: [computer.tool],
      messages,
    });
    // The whole reply, unchanged: thinking blocks and every screenshot stay
    // in the history, which Claude needs to keep its reasoning.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      const d = response.stop_details;
      console.log(`\nClaude declined (${d?.category ?? "no category"}): ${d?.explanation ?? ""}`);
      break;
    }
    for (const block of response.content) {
      if (block.type === "text") console.log(`\nclaude: ${block.text}`);
      if (block.type === "tool_use") console.log(`  [${turn}] ${block.name} ${JSON.stringify(block.input)}`);
    }
    if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
      console.log(`\nstopped: ${response.stop_reason}`);
      break;
    }

    // Run the computer actions; no actions means Claude is done.
    const results = await computer.run(response.content);
    if (results.length === 0) break;
    for (const r of results) if (r.is_error) console.log(`      failed: ${r.content}`);
    messages.push({ role: "user", content: results });
  }
  // Done: the screen follows whoever is watching again.
  await computer.release();
} finally {
  await boxd.close();
}
