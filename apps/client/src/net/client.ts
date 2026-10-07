// The app's wired-up session and authenticated REST calls.
import type { RestResponse, RestRouteName } from '@gp/protocol';

import { i18n } from '../i18n';
import { ApiError, apiFetch } from './api';
import type { ApiRequest } from './api';
import { defaultKv } from './kv';
import { WIRE_PLATFORM } from './platform';
import { browserLocks, Session } from './session';

let shared: Session | null = null;

export function getSession(): Session {
  shared ??= new Session({
    kv: defaultKv(),
    guest: (body) => apiFetch('authGuest', { body }),
    refresh: (refreshToken) => apiFetch('authRefresh', { body: { refreshToken } }),
    now: () => Date.now(),
    locks: browserLocks(),
    guestExtras: () => ({
      locale: i18n.language === 'ta' ? 'ta' : 'en',
      platform: WIRE_PLATFORM,
    }),
  });
  return shared;
}

/** A REST call with the session's access token; on a 401 it refreshes once and retries. */
export async function authedFetch<R extends RestRouteName>(
  route: R,
  req: Omit<ApiRequest<R>, 'token'> = {},
): Promise<RestResponse<R>> {
  const session = getSession();
  const token = await session.getAccessToken();
  try {
    return await apiFetch(route, { ...req, token });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const fresh = await session.refresh(token);
    return apiFetch(route, { ...req, token: fresh.accessToken });
  }
}
