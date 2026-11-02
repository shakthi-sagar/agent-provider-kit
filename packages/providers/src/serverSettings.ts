// agent-provider-kit shim: T3's settings service persists to sqlite and resolves app secrets.
// Providers only read settings, so this keeps the same service tag backed by memory.
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsError,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;
    readonly ready: Effect.Effect<void, ServerSettingsError>;
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;
    readonly streamChanges: Stream.Stream<ServerSettings>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {}

/** In-memory settings: defaults merged with `overrides`. */
export const layerMemory = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ServerSettings>(deepMerge(DEFAULT_SERVER_SETTINGS, overrides));
      const getSettings = Ref.get(ref);
      return ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings,
        updateSettings: Effect.fn("ServerSettingsService.updateSettings")(function* (patch) {
          return yield* Ref.updateAndGet(ref, (current) => applyServerSettingsPatch(current, patch));
        }),
        // shortcut: instance mutations need T3's settings reconciler; port it if a consumer edits instances at runtime.
        updateProviderInstance: Effect.fn("ServerSettingsService.updateProviderInstance")(
          function* () {
            return yield* Effect.die(
              new Error("Provider instance mutation is not supported by agent-provider-kit."),
            );
          },
        ),
        // @effect-diagnostics-next-line effectFnOpportunity:off - generic signature cannot be an Effect.fn
        withSettingsSnapshot: (use) => Effect.flatMap(getSettings, use),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });
    }),
  );
export const layerTest = layerMemory;
