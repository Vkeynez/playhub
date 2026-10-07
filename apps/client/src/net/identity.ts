// Local identity first (ARCHITECTURE §7): on first launch the device gets a guest key, a friendly
// name ("Swift Mango 42") and an avatar seed, offline and instantly. The server guest is created
// from it only when multiplayer is first used.

export interface LocalIdentity {
  /** 128 random bits, base64url (22 chars). The guest's only credential before tokens exist. */
  guestKey: string;
  name: string;
  avatarSeed: string;
  /** Untrusted device label sent in `hello`; never a credential. */
  deviceId: string;
}

export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

const ADJECTIVES = [
  'Swift',
  'Brave',
  'Lucky',
  'Sunny',
  'Clever',
  'Jolly',
  'Mighty',
  'Zesty',
  'Breezy',
  'Cosmic',
  'Daring',
  'Gentle',
  'Happy',
  'Nimble',
  'Rapid',
  'Spicy',
  'Witty',
  'Bold',
  'Calm',
  'Fizzy',
] as const;

const NOUNS = [
  'Mango',
  'Tiger',
  'Peacock',
  'Lotus',
  'Cobra',
  'Monsoon',
  'Comet',
  'Banyan',
  'Falcon',
  'Jasmine',
  'Panther',
  'Parrot',
  'Rocket',
  'Lantern',
  'Coconut',
  'Kite',
  'Elephant',
  'Otter',
  'Pepper',
  'Koel',
] as const;

function pick<T>(list: readonly T[], byte: number): T {
  const value = list[byte % list.length];
  if (value === undefined) throw new Error('empty word list');
  return value;
}

export function friendlyName(random: RandomBytes = cryptoRandomBytes): string {
  const [a = 0, b = 0, c = 0] = random(3);
  return `${pick(ADJECTIVES, a)} ${pick(NOUNS, b)} ${10 + (c % 90)}`;
}

export function createIdentity(random: RandomBytes = cryptoRandomBytes): LocalIdentity {
  return {
    guestKey: base64url(random(16)),
    name: friendlyName(random),
    avatarSeed: base64url(random(6)),
    deviceId: `d-${base64url(random(9))}`,
  };
}

export function isLocalIdentity(value: unknown): value is LocalIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.guestKey === 'string' &&
    v.guestKey.length >= 22 &&
    typeof v.name === 'string' &&
    typeof v.avatarSeed === 'string' &&
    typeof v.deviceId === 'string'
  );
}

/** A stable hue (0–359) for an avatar seed, so a player keeps their colour on every device. */
export function avatarHue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}
