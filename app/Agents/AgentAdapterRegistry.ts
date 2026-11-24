import { defaultAgentCapabilities, type AgentAdapter, type AgentCapabilities } from './AgentProtocol';

// Central registry of runtime agent adapters. Core services resolve adapters
// and query their declared capabilities here instead of switching on hardcoded
// provider names.
export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(entries: Iterable<readonly [string, AgentAdapter]> = []) {
    for (const [id, adapter] of entries) {
      this.register(id, adapter);
    }
  }

  static fromRecord(record: Partial<Record<string, AgentAdapter>>): AgentAdapterRegistry {
    const registry = new AgentAdapterRegistry();
    for (const [id, adapter] of Object.entries(record)) {
      if (adapter) registry.register(id, adapter);
    }
    return registry;
  }

  register(id: string, adapter: AgentAdapter): this {
    this.adapters.set(id, adapter);
    return this;
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Integrated provider ${id} is not configured`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  list(): Array<{ id: string; adapter: AgentAdapter; capabilities: AgentCapabilities }> {
    return [...this.adapters.entries()].map(([id, adapter]) => ({
      id,
      adapter,
      capabilities: adapter.capabilities ?? defaultAgentCapabilities()
    }));
  }

  capabilities(id: string): AgentCapabilities {
    return this.adapters.get(id)?.capabilities ?? defaultAgentCapabilities();
  }

  byCapability(predicate: (capabilities: AgentCapabilities, id: string) => boolean): Array<{ id: string; adapter: AgentAdapter }> {
    return this.list()
      .filter(({ id, capabilities }) => predicate(capabilities, id))
      .map(({ id, adapter }) => ({ id, adapter }));
  }
}
