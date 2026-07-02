/* Last-known analyzer (Ollama) GPU/CPU placement, mirroring vram-state.ts's
   cache shape. Populated wherever detectOllamaDevice() already runs (it's
   async; this sync cache is what the W2.6 cost/eviction guards read). */

export type AnalyzerDevice = 'cuda' | 'cpu' | 'unknown';

let lastKnownAnalyzerDevice: AnalyzerDevice = 'unknown';

export function setLastKnownAnalyzerDevice(device: AnalyzerDevice): void {
  lastKnownAnalyzerDevice = device;
}

export function getLastKnownAnalyzerDevice(): AnalyzerDevice {
  return lastKnownAnalyzerDevice;
}
