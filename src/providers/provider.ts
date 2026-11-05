import type { ProviderSnapshot } from "../domain/types.js";

/** Implement only against a source whose terms and written permissions allow your intended use. */
export interface CricketProvider {
  readonly id: string;
  fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot>;
}
