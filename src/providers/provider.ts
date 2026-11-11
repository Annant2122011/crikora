import type { ProviderSnapshot } from "../domain/types.js";

/** Backend-only adapter for a source whose access and redistribution are authorized. */
export interface CricketProvider {
  readonly id: string;
  fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot>;
  fetchMatchIndexSnapshot?(signal?: AbortSignal): Promise<ProviderSnapshot>;
}
