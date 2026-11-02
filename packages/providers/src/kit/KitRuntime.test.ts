// @effect-diagnostics nodeBuiltinImport:off - test setup needs a temp dir before the layer exists.
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AntigravityDriver } from "../provider/Drivers/AntigravityDriver.ts";
import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import * as KitRuntime from "./KitRuntime.ts";

const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "apk-kit-"));

// Typed assignment (not a cast) proves the kit layer satisfies every driver's requirements.
const drivers: ReadonlyArray<AnyProviderDriver<KitRuntime.KitServices>> = [
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  AcpRegistryDriver,
];

describe("KitRuntime", () => {
  for (const driver of drivers) {
    it.effect(`creates a disabled ${driver.driverKind} instance`, () =>
      Effect.gen(function* () {
        const instance = yield* driver.create({
          instanceId: ProviderInstanceId.make(`${driver.driverKind}-test`),
          displayName: undefined,
          environment: [],
          enabled: false,
          config: driver.defaultConfig(),
        });
        assert.equal(instance.driverKind, driver.driverKind);
        assert.isFunction(instance.orchestrationAdapter.openSession);
      }).pipe(Effect.provide(KitRuntime.layer({ baseDir })), Effect.scoped),
    );
  }
});
