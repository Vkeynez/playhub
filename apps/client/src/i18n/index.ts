// i18next setup (ARCHITECTURE §6.8): English + Tamil bundled with the shell, English fallback.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './en';
import { ta } from './ta';

export type Language = 'en' | 'ta';

function initialLanguage(): Language {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language?.toLowerCase().startsWith('ta') ? 'ta' : 'en';
}

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: { en: { translation: en }, ta: { translation: ta } },
    lng: initialLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
}

export const i18n = i18next;

/** "dev-tictactoe" → "devTictactoe": the manifest key segment for a game id. */
export function gameKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
