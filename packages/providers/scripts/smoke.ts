// Live smoke test against an installed, logged-in agent CLI. Spends real tokens.
// usage: node scripts/smoke.ts <claude|codex|antigravity> <model>
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createAgentKit, type AgentProvider } from "../src/kit/Agent.ts";

const [provider, model] = process.argv.slice(2) as [AgentProvider, string];
const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "apk-smoke-"));
// Default baseDir (~/.agent-provider-kit) so managed runtimes download once.
const kit = createAgentKit();
const counts = new Map<string, number>();
try {
  if (provider === "antigravity") console.log("runtime:", (await kit.install("antigravity")).installedVersion);
  const agent = await kit.open({ provider, model, cwd });
  if (process.env.SMOKE_DEBUG) console.error("opened", agent.providerThread.id);
  for (const turn of ["Reply with exactly: PONG", "Now reply with exactly: PING"]) {
    let text = "";
    for await (const event of agent.send(turn)) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      if (process.env.SMOKE_DEBUG) console.error(new Date().toISOString().slice(11, 19), event.type, JSON.stringify(event).slice(0, 300));
      if (event.type === "message.updated" && event.message.role === "assistant") text = event.message.text;
      if (event.type === "turn.terminal") console.log(`turn ${event.runOrdinal}: ${event.status} -> ${JSON.stringify(text)}`);
    }
  }
  console.log("events:", Object.fromEntries(counts));
} finally {
  await kit.dispose();
}
