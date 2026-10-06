// Game registry (ARCHITECTURE §3.7): manifests are eager and tiny (they drive Home offline);
// the logic module and the game UI are lazy chunks loaded only when a match starts.

import type { GameRegistration } from '../room/types';

const registry = new Map<string, GameRegistration>();

export function registerGame(registration: GameRegistration): void {
  const { id } = registration.manifest;
  if (registry.has(id)) throw new Error(`game ${id} registered twice`);
  registry.set(id, registration);
}

export function getGame(id: string): GameRegistration | undefined {
  return registry.get(id);
}

export function isRegistered(id: string): boolean {
  return registry.has(id);
}
