// @effect-diagnostics nodeBuiltinImport:off - the facade under test is plain Promise code.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, assert, describe, expect, it, vi } from "vitest";

import { CheckpointId } from "@t3tools/contracts";
import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import { createAgentKit, type AgentEvent } from "./Agent.ts";

// T3's mock ACP agent exercises the facade end to end without network or credentials.
const mockAgent = NodePath.resolve(import.meta.dirname, "../../scripts/acp-mock-agent.ts");
const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "apk-agent-"));
const kit = createAgentKit({ baseDir });
const acp = {
  provider: "acp",
  config: { source: "local", commandPath: process.execPath, commandArgs: [mockAgent] },
} as const;

afterAll(() => kit.dispose());

const collect = async (events: AsyncIterable<AgentEvent>) => {
  const all: Array<AgentEvent> = [];
  for await (const event of events) all.push(event);
  return all;
};

const requestLog = NodePath.join(baseDir, "features.ndjson");
const features = {
  ...acp,
  instance: "features",
  env: { T3_ACP_SESSION_LIFECYCLE: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
} as const;

describe("createAgentKit", () => {
  it("closing an active session wakes its waiting event consumer", async () => {
    const agent = await kit.open({
      ...acp,
      instance: "closing",
      env: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
      model: "default",
      cwd: baseDir,
    });
    const iterator = agent.send("hang until closed")[Symbol.asyncIterator]();
    try {
      let next;
      do {
        next = await iterator.next();
      } while (!next.done && next.value.type !== "provider_turn.updated");
      assert.isFalse(next.done);
      await agent.close();
      await expect(
        (async () => {
          while (!(await iterator.next()).done) {}
        })(),
      ).rejects.toThrow(/Agent turn failed/);
    } finally {
      await iterator.return?.();
      await agent.close();
    }
  }, 30_000);

  it("forwards compaction, rollback, task and subagent controls to supported adapters", async () => {
    const steer = vi.fn<ProviderAdapterV2SessionRuntime["steerTurn"]>(() => Effect.void);
    const stopTask = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["stopTask"]>>(
      () => Effect.void,
    );
    const awaitTasks = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["awaitBackgroundTasks"]>>(
      (input) => Effect.succeed({ matched: input.taskIds }),
    );
    const stopSubagent = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["stopSubagent"]>>(
      () => Effect.void,
    );
    const rollback = vi.fn<ProviderAdapterV2SessionRuntime["rollbackThread"]>((input) =>
      Effect.succeed({
        providerThread: input.providerThread,
        providerTurns: [],
        messages: [],
        runtimeRequests: [],
      }),
    );
    const compact = vi.fn<NonNullable<ProviderAdapterV2SessionRuntime["compactThread"]>>();
    const originalCreate = AcpRegistryDriver.create;
    const spy = vi.spyOn(AcpRegistryDriver, "create").mockImplementation((input) =>
      originalCreate(input).pipe(
        Effect.map((instance) => ({
          ...instance,
          orchestrationAdapter: {
            ...instance.orchestrationAdapter,
            openSession: (input) =>
              instance.orchestrationAdapter.openSession(input).pipe(
                Effect.map((runtime) => {
                  compact.mockImplementation((turn) => runtime.startTurn(turn));
                  return {
                    ...runtime,
                    providerSession: {
                      ...runtime.providerSession,
                      capabilities: {
                        ...runtime.providerSession.capabilities,
                        threads: {
                          ...runtime.providerSession.capabilities.threads,
                          canRollbackThread: true,
                        },
                        turns: {
                          ...runtime.providerSession.capabilities.turns,
                          supportsActiveSteering: true,
                        },
                      },
                    },
                    compactThread: compact,
                    steerTurn: steer,
                    rollbackThread: rollback,
                    stopTask,
                    awaitBackgroundTasks: awaitTasks,
                    stopSubagent,
                  };
                }),
              ),
          },
        })),
      ),
    );
    let agent;
    try {
      agent = await kit.open({
        ...features,
        instance: "instrumented",
        env: { ...features.env, T3_ACP_PROMPT_DELAY_MS: "100" },
        model: "default",
        cwd: baseDir,
      });
      await agent.stopTask("task-1");
      assert.equal(stopTask.mock.calls[0]?.[0].taskId, "task-1");
      assert.deepEqual(await agent.awaitBackgroundTasks(["task-1"], false), {
        matched: ["task-1"],
      });
      assert.equal(awaitTasks.mock.calls[0]?.[0].awaited, false);
      await agent.stopSubagent("child-1");
      assert.equal(stopSubagent.mock.calls[0]?.[0].nativeTaskId, "child-1");
      const target = {
        type: "thread_start",
        checkpointId: CheckpointId.make("checkpoint-test"),
        appRunOrdinal: 0,
      } as const;
      await agent.rollback({ target, providerThreadTurns: [] });
      assert.deepEqual(rollback.mock.calls[0]?.[0].target, target);
      const events = await collect(agent.compact("Keep the current task"));
      assert.equal(events.at(-1)?.type, "turn.terminal");
      assert.equal(compact.mock.calls[0]?.[0].message.text, "Keep the current task");
      const iterator = agent.send("steerable turn")[Symbol.asyncIterator]();
      try {
        let next;
        do {
          next = await iterator.next();
        } while (
          !next.done &&
          !(
            next.value.type === "provider_turn.updated" &&
            next.value.providerTurn.status === "running"
          )
        );
        assert.isFalse(next.done);
        await agent.steer("new direction");
        assert.equal(steer.mock.calls[0]?.[0].message.text, "new direction");
        do {
          next = await iterator.next();
        } while (!next.done);
      } finally {
        await iterator.return?.();
      }
    } finally {
      await agent?.close();
      spy.mockRestore();
    }
  }, 60_000);

  it("exposes capability queries, native listings, history and independent forks", async () => {
    const agent = await kit.open({ ...features, model: "default", cwd: baseDir });
    try {
      const capabilities = await agent.capabilities();
      assert.isTrue(capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(capabilities.threads.canForkThread);
      assert.isTrue(kit.listSessions().includes(agent));
      const native = await kit.listNativeSessions({ ...features, cwd: baseDir });
      assert.isAbove(native.sessions.length, 0);
      await collect(agent.send("source turn"));
      const history = await agent.history();
      assert.equal(
        history.providerThread.nativeThreadRef?.nativeId,
        agent.providerThread.nativeThreadRef?.nativeId,
      );
      const fork = await agent.fork();
      try {
        assert.notEqual(
          fork.providerThread.nativeThreadRef?.nativeId,
          agent.providerThread.nativeThreadRef?.nativeId,
        );
        assert.isTrue(kit.listSessions().includes(fork));
        const events = await collect(fork.send("fork turn"));
        assert.equal(events.at(-1)?.type, "turn.terminal");
        assert.equal(
          (await collect(agent.send("source remains independent"))).at(-1)?.type,
          "turn.terminal",
        );
        assert.notEqual(
          fork.providerThread.nativeThreadRef?.nativeId,
          agent.providerThread.nativeThreadRef?.nativeId,
        );
        const prompts = NodeFS.readFileSync(requestLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.method === "session/prompt");
        assert.equal(
          prompts.at(-2)?.params.sessionId,
          fork.providerThread.nativeThreadRef?.nativeId,
        );
        assert.equal(
          prompts.at(-1)?.params.sessionId,
          agent.providerThread.nativeThreadRef?.nativeId,
        );
      } finally {
        await fork.close();
      }
    } finally {
      await agent.close();
    }
    assert.isFalse(kit.listSessions().includes(agent));
    await expect(agent.history()).rejects.toThrow(/closed/);
  }, 60_000);

  it("changes selection before the next turn and sends stored attachments", async () => {
    const agent = await kit.open({ ...features, model: "default", cwd: baseDir });
    try {
      const source = NodePath.join(baseDir, "note.txt");
      NodeFS.writeFileSync(source, "attachment contents");
      const attachment = await kit.attachment(source, { mimeType: "text/plain" });
      assert.equal(attachment.sizeBytes, 19);
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(baseDir, "userdata", "attachments", `${attachment.id}.txt`),
          "utf8",
        ),
        "attachment contents",
      );
      await expect(kit.attachment(baseDir, { mimeType: "text/plain" })).rejects.toThrow(
        /must be a file/,
      );
      await agent.configure({ model: "composer-2" });
      const events = await collect(agent.send("read attachment", { attachments: [attachment] }));
      assert.equal(events.at(-1)?.type, "turn.terminal");
      const log = NodeFS.readFileSync(requestLog, "utf8");
      assert.include(log, "composer-2");
      assert.include(log, "note.txt");
      assert.isFalse(await agent.hasPendingBackgroundWork());
    } finally {
      await agent.close();
    }
  }, 60_000);

  it("rejects unsupported operations clearly and keeps the session usable", async () => {
    const agent = await kit.open({ ...acp, model: "default", cwd: baseDir });
    try {
      await expect(agent.steer("no active turn")).rejects.toThrow(/No active/);
      await expect(agent.stopTask("missing")).rejects.toThrow(/does not support/);
      await expect(agent.stopSubagent("missing")).rejects.toThrow(/does not support/);
      await expect(agent.awaitBackgroundTasks(["missing"])).rejects.toThrow(/does not support/);
      await expect(collect(agent.compact())).rejects.toThrow();
      assert.equal((await collect(agent.send("still works"))).at(-1)?.type, "turn.terminal");
    } finally {
      await agent.close();
    }
    await expect(collect(agent.send("closed"))).rejects.toThrow(/closed/);
  }, 60_000);

  it("rejects concurrent sends without stealing the active turn's events", async () => {
    const agent = await kit.open({ ...acp, model: "default", cwd: baseDir });
    const iterator = agent.send("first")[Symbol.asyncIterator]();
    try {
      await iterator.next();
      await expect(collect(agent.send("second"))).rejects.toThrow(/active/);
      let next;
      do {
        next = await iterator.next();
      } while (!next.done);
      assert.equal((await collect(agent.send("after first"))).at(-1)?.type, "turn.terminal");
    } finally {
      await iterator.return?.();
      await agent.close();
    }
  }, 60_000);

  it("discovers and refreshes model catalogs without opening a chat", async () => {
    const models = await kit.models({ ...acp, cwd: baseDir });
    assert.isAbove(models.length, 0);
    assert.isTrue(models.every((model) => model.slug.length > 0 && model.name.length > 0));
    const refreshed = await kit.models({ ...acp, cwd: baseDir, refresh: true });
    assert.deepEqual(
      refreshed.map((model) => model.slug),
      models.map((model) => model.slug),
    );
  }, 60_000);

  it("runs consecutive turns and ends each at its own terminal", async () => {
    const agent = await kit.open({ ...acp, model: "default", cwd: baseDir });
    for (const ordinal of [1, 2]) {
      const events = await collect(agent.send(`turn ${ordinal}`));
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "turn.terminal");
      assert.equal(terminal?.type === "turn.terminal" && terminal.runOrdinal, ordinal);
      assert.isTrue(
        events.some((e) => e.type === "message.updated" && e.message.role === "assistant"),
      );
    }
    await agent.close();
  }, 60_000);

  it.each(["object", "serialized"] as const)(
    "resumes a native conversation from %s after recreating the kit",
    async (format) => {
      const firstKit = createAgentKit({ baseDir });
      const original = await firstKit.open({ ...acp, model: "default", cwd: baseDir });
      await collect(original.send("remember this conversation"));
      const thread = original.providerThread;
      const resume = format === "serialized" ? original.serialize() : thread;
      await firstKit.dispose();
      const secondKit = createAgentKit({ baseDir });
      try {
        const resumed = await secondKit.open({ ...acp, model: "default", cwd: baseDir, resume });
        assert.equal(
          resumed.providerThread.nativeThreadRef?.nativeId,
          thread.nativeThreadRef?.nativeId,
        );
        assert.equal(resumed.providerThread.id, thread.id);
        const events = await collect(resumed.send("continue"));
        const terminal = events.at(-1);
        assert.equal(terminal?.type, "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" && terminal.runOrdinal, 2);
      } finally {
        await secondKit.dispose();
      }
    },
    60_000,
  );

  it("rejects malformed resume tokens and mismatched provider instances", async () => {
    await expect(
      kit.open({ ...acp, model: "default", cwd: baseDir, resume: "not-json" }),
    ).rejects.toThrow();
    const agent = await kit.open({ ...acp, model: "default", cwd: baseDir });
    try {
      await expect(
        kit.open({
          ...acp,
          instance: "another-instance",
          model: "default",
          cwd: baseDir,
          resume: agent.serialize(),
        }),
      ).rejects.toThrow(/same provider and instance/);
      await expect(
        kit.open({ provider: "pi", model: "default", cwd: baseDir, resume: agent.serialize() }),
      ).rejects.toThrow(/same provider and instance/);
    } finally {
      await agent.close();
    }
  }, 60_000);

  it("shares one instance per name and rejects conflicting settings", async () => {
    const first = await kit.open({ ...acp, model: "default", cwd: baseDir });
    const second = await kit.open({ ...acp, model: "default", cwd: baseDir });
    assert.equal(first.providerThread.providerInstanceId, second.providerThread.providerInstanceId);
    let error: unknown;
    try {
      await kit.open({ ...acp, env: { FOO: "1" }, model: "default", cwd: baseDir });
    } catch (cause) {
      error = cause;
    }
    assert.match(String(error), /already open with other settings/);
    await Promise.all([first.close(), second.close()]);
  }, 60_000);

  it("rejects settings the driver schema does not accept", async () => {
    let error: unknown;
    try {
      await kit.open({
        provider: "acp",
        instance: "invalid",
        config: { source: "nope" },
        model: "default",
        cwd: baseDir,
      });
    } catch (cause) {
      error = cause;
    }
    assert.isDefined(error);
  });

  it("rejects instance names that are not slugs, with a readable message", async () => {
    let error: unknown;
    try {
      await kit.open({
        provider: "acp",
        instance: "acp-/usr/bin/node",
        model: "default",
        cwd: baseDir,
      });
    } catch (cause) {
      error = cause;
    }
    assert.match(String(error), /must start with a letter/);
  });
});
