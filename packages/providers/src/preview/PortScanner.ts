// agent-provider-kit shim: T3's preview port discovery is app-only. Keeps the service tag the
// Claude adapter asks for; the default layer tracks nothing.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    /** Counts a running agent until the returned function is called. */
    readonly trackAgent: () => () => void;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const layerNoop = Layer.succeed(PortDiscovery, PortDiscovery.of({ trackAgent: () => () => {} }));

/** Agents launch with this set to their thread id. */
export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";
