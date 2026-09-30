import type { ReleaseState, ResourceRelease } from "../contracts/index.ts";
import { ControlPlaneError } from "./errors.ts";

const transitions: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = {
  draft: ["validated"],
  validated: ["observe", "canary"],
  observe: ["canary", "active", "rolled_back"],
  canary: ["active", "rolled_back"],
  active: ["superseded", "rolled_back", "retired"],
  superseded: ["rolled_back", "retired"],
  rolled_back: ["retired"],
  retired: [],
};

export function canTransitionRelease(from: ReleaseState, to: ReleaseState): boolean {
  return transitions[from].includes(to);
}

/** Returns a new immutable release; it never mutates a historical release. */
export function transitionRelease(release: ResourceRelease, state: ReleaseState): ResourceRelease {
  if (!canTransitionRelease(release.state, state)) {
    throw new ControlPlaneError("invalid_release_transition", `Cannot transition release ${release.releaseId} from ${release.state} to ${state}`);
  }
  return freezeRelease({ ...release, state, payload: release.payload });
}

/**
 * Takes an already-validated release payload and freezes a defensive copy.
 * Hashing and persistence are intentionally ports in later work packages.
 */
export function freezeRelease(release: ResourceRelease): ResourceRelease {
  return deepFreeze({ ...release, payload: cloneJsonObject(release.payload) });
}

function cloneJsonObject(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
