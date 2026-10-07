// Invite helpers (ARCHITECTURE §6.5 "Share"): WhatsApp first, then the share sheet, copy and QR.
import { Linking, Platform, Share } from 'react-native';

export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export async function openWhatsApp(text: string): Promise<void> {
  await Linking.openURL(whatsappUrl(text));
}

interface WebNavigator {
  share?(data: { title?: string; text?: string; url?: string }): Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

function webNavigator(): WebNavigator | null {
  if (Platform.OS !== 'web') return null;
  return (globalThis as { navigator?: WebNavigator }).navigator ?? null;
}

/** Web Share API on web (when present), the native share sheet on Android. */
export function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof webNavigator()?.share === 'function';
}

export async function shareInvite(title: string, text: string, url: string): Promise<void> {
  const nav = webNavigator();
  if (nav?.share) {
    try {
      await nav.share({ title, text, url });
    } catch {
      // The person closed the sheet.
    }
    return;
  }
  await Share.share({ title, message: `${text} ${url}` });
}

export function canCopy(): boolean {
  return typeof webNavigator()?.clipboard?.writeText === 'function';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await webNavigator()?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Reads the clipboard for the code box's Paste button (web only; the browser may ask first). */
export async function readClipboard(): Promise<string | null> {
  const clip = (webNavigator()?.clipboard ?? null) as { readText?(): Promise<string> } | null;
  if (!clip?.readText) return null;
  try {
    return await clip.readText();
  } catch {
    return null;
  }
}

export function canPaste(): boolean {
  const clip = (webNavigator()?.clipboard ?? null) as { readText?: unknown } | null;
  return typeof clip?.readText === 'function';
}
