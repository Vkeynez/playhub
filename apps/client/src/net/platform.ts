import { Platform } from 'react-native';

import type { Platform as WirePlatform } from '@gp/protocol';

export const WIRE_PLATFORM: WirePlatform = Platform.OS === 'android' ? 'android' : 'web';

/** Android WebViews (WhatsApp's in-app browser among them) put "; wv)" in the user agent (§6.5). */
export function isInAppBrowser(): boolean {
  if (Platform.OS !== 'web') return false;
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
  return /; wv\)/.test(ua);
}
