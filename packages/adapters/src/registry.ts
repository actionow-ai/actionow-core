import type { ProviderAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerType, adapter);
  }
  has(providerType: string): boolean {
    return this.adapters.has(providerType);
  }
  get(providerType: string): ProviderAdapter {
    const a = this.adapters.get(providerType);
    if (!a) throw new Error(`no adapter for provider_type "${providerType}"`);
    return a;
  }
  /** The provider types of every registered adapter (registration order). */
  providerTypes(): string[] {
    return [...this.adapters.keys()];
  }
}
