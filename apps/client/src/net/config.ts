// Where the client finds the API and how it describes itself (ARCHITECTURE §4.4, §6.5).
// Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time, so these must stay literal member reads.
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** REST + Socket.IO origin. */
export const API_URL = trimSlash(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:10000');

/** The web app's public origin: invite links always point here, whichever platform shares them. */
export const WEB_URL = trimSlash(
  process.env.EXPO_PUBLIC_WEB_URL ?? 'https://playhub-web.onrender.com',
);

/** Semver of this build; sent in `hello`. Keep in step with app.json `expo.version`. */
export const APP_VERSION = '0.1.0';

export function joinUrl(code: string): string {
  return `${WEB_URL}/join/${code}`;
}
