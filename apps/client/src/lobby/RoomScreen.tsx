// /room/<roomId>: connects a RemoteRoom, then shows the lobby or the match (the game's own Screen,
// fed by RemoteRoom exactly as LocalRoom feeds it offline), plus every connection state:
// waking, connecting, reconnecting, update required, server updating, failed.
import type { RoomSnapshot } from '@gp/protocol';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RESULT_DELAY_MS, ScreenBoundary } from '../host/GameHost';
import { outcomeFor, ResultSheet } from '../host/ResultSheet';
import type { Outcome } from '../host/ResultSheet';
import { getGame } from '../registry';
import { UiNotReadyError } from '../registry/games';
import { connectRoom } from '../room/connect';
import type { RemoteRoom, RemoteRoomInfo } from '../room/RemoteRoom';
import type { GameRegistration, GameScreenProps, GameUiModule, ScreenPlayer } from '../room/types';
import { ensureSkia } from '../skia';
import { Backdrop } from '../ui/Backdrop';
import { Button } from '../ui/Button';
import { InAppHint } from '../ui/InAppHint';
import { colors, CONTENT_MAX, font, radius, space, TOUCH } from '../ui/theme';
import { WakeBanner } from '../ui/WakeBanner';
import { joinErrorFor, roomHref } from './joinFlow';
import type { JoinErrorCode } from './joinFlow';
import { Lobby, occupantName } from './Lobby';
import type { PreloadState } from './Lobby';

function goHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function RoomScreen({ roomId, watch }: { roomId: string; watch: boolean }) {
  const { t } = useTranslation();
  const [room, setRoom] = useState<RemoteRoom | null>(null);
  const [error, setError] = useState<JoinErrorCode | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let made: RemoteRoom | null = null;
    setError(null);
    connectRoom({ roomId, asSpectator: watch }).then(
      (r) => {
        if (!live) r.dispose();
        else {
          made = r;
          setRoom(r);
        }
      },
      (e: unknown) => live && setError(joinErrorFor(e)),
    );
    return () => {
      live = false;
      made?.dispose();
      setRoom(null);
    };
  }, [roomId, watch, attempt]);

  if (error) {
    return (
      <RoomMessage
        title={t(`join.errors.${error}`)}
        actions={<Button label={t('common.retry')} onPress={() => setAttempt((n) => n + 1)} />}
      />
    );
  }
  if (!room) return <Connecting label={t('lobby.connecting')} />;
  return <ConnectedRoom room={room} />;
}

function useRoomInfo(room: RemoteRoom): RemoteRoomInfo {
  const subscribe = useCallback((fn: () => void) => room.subscribeInfo(fn), [room]);
  const get = useCallback(() => room.getInfo(), [room]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Loads the game's UI chunk (and CanvasKit for Skia games) while the lobby is open (§6.5). */
function usePreload(registration: GameRegistration | undefined): {
  state: PreloadState;
  ui: GameUiModule | null;
} {
  const [ui, setUi] = useState<GameUiModule | null>(null);
  const [state, setState] = useState<PreloadState>('loading');
  useEffect(() => {
    if (!registration) return;
    let live = true;
    const load = async () => {
      if (registration.usesSkia) await ensureSkia();
      const module = await registration.load();
      await module.loadAssets?.();
      return module;
    };
    load().then(
      (module) => {
        if (!live) return;
        setUi(module);
        setState('loaded');
      },
      (e: unknown) => live && setState(e instanceof UiNotReadyError ? 'not-ready' : 'error'),
    );
    return () => {
      live = false;
    };
  }, [registration]);
  return { state, ui };
}

function ConnectedRoom({ room }: { room: RemoteRoom }) {
  const { t } = useTranslation();
  const info = useRoomInfo(room);
  const snapshot = info.snapshot;
  const registration = snapshot ? getGame(snapshot.gameId) : undefined;
  const preload = usePreload(registration);
  const gameName = registration ? t(registration.manifest.name) : '';

  // Presence while live; rejoin at once when the app comes back with a dead socket (§6.6).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => room.setActive(s === 'active'));
    return () => sub.remove();
  }, [room]);

  const leave = () => {
    void room.leave().finally(() => router.replace('/'));
  };

  if (info.status === 'failed') {
    const failure = info.failure ?? 'NOT_FOUND';
    return (
      <RoomMessage
        title={t(`join.errors.${failure}`)}
        actions={
          failure === 'ROOM_FULL' ? (
            <Button
              label={t('join.watchLive')}
              onPress={() => router.replace(roomHref(room.roomId, true))}
              testID="watch-live"
            />
          ) : null
        }
      />
    );
  }
  if (info.status === 'blocked') {
    const tooOld = info.failure === 'CLIENT_TOO_OLD';
    return (
      <RoomMessage
        title={tooOld ? t('lobby.updateRequired') : t('lobby.serverUpdating')}
        body={tooOld ? t('lobby.updateRequiredBody') : t('lobby.serverUpdatingBody')}
        busy={!tooOld}
        actions={
          tooOld ? <Button label={t('lobby.reload')} onPress={reloadApp} testID="reload" /> : null
        }
      />
    );
  }
  if (!snapshot) return <Connecting label={t('lobby.connecting')} />;
  if (!registration) return <RoomMessage title={t('host.unknownGame')} />;

  const inMatch = snapshot.phase === 'IN_PROGRESS' || snapshot.phase === 'FINISHED';
  return (
    <View style={styles.root}>
      <Backdrop />
      <RoomHeader
        title={t('lobby.title', { game: gameName })}
        onBack={snapshot.phase === 'LOBBY' ? leave : goHome}
        chip={snapshot.yourSeat === null ? t('lobby.spectating') : null}
      />
      {info.status === 'reconnecting' && <ReconnectingBanner />}
      <View style={styles.banners}>
        <WakeBanner />
      </View>
      <View style={styles.stage}>
        {snapshot.phase === 'CLOSED' ? (
          <Centered>
            <Text style={styles.messageTitle}>{t('join.errors.ROOM_CLOSED')}</Text>
          </Centered>
        ) : inMatch ? (
          preload.ui ? (
            <RemoteMatch
              key={snapshot.matchId ?? 'match'}
              room={room}
              ui={preload.ui}
              snapshot={snapshot}
              onLeave={leave}
            />
          ) : preload.state === 'loading' ? (
            <Connecting label={t('host.loadingSkia')} bare />
          ) : (
            <Centered>
              <Text style={styles.messageTitle}>{t('host.notReady', { name: gameName })}</Text>
            </Centered>
          )
        ) : (
          <Lobby
            room={room}
            snapshot={snapshot}
            gameName={gameName}
            preload={preload.state}
            onLeave={leave}
          />
        )}
      </View>
    </View>
  );
}

function reloadApp() {
  const location = (globalThis as { location?: { reload(): void } }).location;
  if (location) location.reload();
  else router.replace('/');
}

function playersOf(snapshot: RoomSnapshot, t: (key: string) => string): ScreenPlayer[] {
  return snapshot.seats
    .filter((s) => s.occupant !== null)
    .map((s) => ({
      seat: s.seat,
      name: occupantName(s, t),
      bot: s.occupant?.kind === 'bot',
    }));
}

interface RemoteMatchProps {
  room: RemoteRoom;
  ui: GameUiModule;
  snapshot: RoomSnapshot;
  onLeave(): void;
}

function RemoteMatch({ room, ui, snapshot, onLeave }: RemoteMatchProps) {
  const { t } = useTranslation();
  const subscribe = useCallback((fn: () => void) => room.subscribe(fn), [room]);
  const getState = useCallback(() => room.getState(), [room]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const submit = useCallback((action: unknown) => room.submit(action), [room]);
  const serverNow = useCallback(() => room.serverNow(), [room]);
  const [showResult, setShowResult] = useState(false);
  const [rematchSent, setRematchSent] = useState(false);
  const finished = snapshot.phase === 'FINISHED' || state.result !== null;

  useEffect(() => {
    setShowResult(false);
    if (!finished) return;
    const id = setTimeout(() => setShowResult(true), RESULT_DELAY_MS);
    return () => clearTimeout(id);
  }, [finished]);

  const players = playersOf(snapshot, t);
  const mySeat = snapshot.yourSeat;
  const nameOf = (seat: number) => players.find((p) => p.seat === seat)?.name ?? '';
  const others = players.filter((p) => p.seat !== mySeat);
  const otherName = others[0]?.name ?? t('lobby.opponent');

  let outcome: Outcome = 'draw';
  let title = t('result.over');
  let subtitle: string | undefined;
  // An abandoned match (no human connected for 5 min) has no winner to celebrate.
  if (state.result && !snapshot.result?.abandoned) {
    const winners = state.result.placements.filter((p) => p.place === 1).map((p) => p.seat);
    if (mySeat !== null) {
      outcome = outcomeFor(state.result, mySeat);
      title =
        outcome === 'lose'
          ? t('result.theyWin', { name: nameOf(winners[0] ?? -1) || otherName })
          : t(`result.${outcome}`);
    } else {
      outcome = winners.length === 1 ? 'win' : 'draw';
      title =
        winners.length === 1
          ? t('result.seatWins', { name: nameOf(winners[0] ?? -1) })
          : t('result.draw');
      subtitle = t('result.watchedSub');
    }
  }

  const accepted = snapshot.rematch?.accepted ?? [];
  const iAccepted = mySeat !== null && (accepted.includes(mySeat) || rematchSent);
  const offerFrom = accepted.find((s) => s !== mySeat);
  const note = iAccepted
    ? t('lobby.rematchWaiting', { name: otherName })
    : offerFrom !== undefined
      ? t('lobby.rematchOffer', { name: nameOf(offerFrom) || otherName })
      : null;

  const grace = snapshot.deadlines.find((d) => d.kind === 'grace' && d.seats.length > 0);

  const Screen = ui.Screen as ComponentType<GameScreenProps>;
  return (
    <View style={styles.match}>
      <ScreenBoundary fallback={<Text style={styles.muted}>{t('host.errorBody')}</Text>}>
        <Screen
          view={state.view}
          events={state.events}
          version={state.version}
          meta={state.meta}
          seat={room.seat}
          submit={submit}
          serverNow={serverNow}
          mode={snapshot.mode}
          config={snapshot.options ?? {}}
          botLevel="medium"
          players={players}
        />
      </ScreenBoundary>
      {grace && !finished && (
        <GraceBanner
          name={nameOf(grace.seats[0] ?? -1) || otherName}
          at={grace.at}
          serverNow={serverNow}
        />
      )}
      {showResult && (
        <ResultSheet
          outcome={outcome}
          title={title}
          {...(subtitle ? { subtitle } : {})}
          homeLabel={t('lobby.leave')}
          rematchDisabled={mySeat === null || iAccepted}
          note={note}
          onRematch={() => {
            setRematchSent(true);
            void room.rematch(true).then((ack) => {
              if (!ack.ok) setRematchSent(false);
            });
          }}
          onHome={onLeave}
        />
      )}
    </View>
  );
}

function GraceBanner({ name, at, serverNow }: { name: string; at: number; serverNow(): number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, [serverNow]);
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <Animated.View entering={FadeInDown} style={styles.grace} role="status" pointerEvents="none">
      <Text style={styles.graceText}>{t('lobby.grace', { name, seconds })}</Text>
    </Animated.View>
  );
}

function ReconnectingBanner() {
  const { t } = useTranslation();
  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOutUp.duration(160)}
      style={styles.reconnecting}
      role="status"
      accessibilityLiveRegion="polite"
      testID="reconnecting"
    >
      <ActivityIndicator size="small" color={colors.marigold} />
      <Text style={styles.reconnectingText}>{t('lobby.reconnecting')}</Text>
    </Animated.View>
  );
}

function RoomHeader({
  title,
  onBack,
  chip,
}: {
  title: string;
  onBack(): void;
  chip?: string | null;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={t('common.backHome')}
        testID="back"
        style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.backGlyph}>‹</Text>
      </Pressable>
      <Text style={styles.title} numberOfLines={1} role="heading" aria-level={1}>
        {title}
      </Text>
      {chip ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{chip}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Connecting({ label, bare = false }: { label: string; bare?: boolean }) {
  const body = (
    <Centered>
      <ActivityIndicator color={colors.marigold} size="large" />
      <Text style={styles.muted}>{label}</Text>
      <View style={styles.wakeWrap}>
        <WakeBanner />
      </View>
    </Centered>
  );
  if (bare) return body;
  return (
    <View style={styles.root}>
      <Backdrop />
      <RoomHeader title="" onBack={goHome} />
      <View style={styles.wakeWrap}>
        <InAppHint />
      </View>
      {body}
    </View>
  );
}

export function RoomMessage({
  title,
  body,
  actions,
  busy = false,
}: {
  title: string;
  body?: string;
  actions?: ReactNode;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.root}>
      <Backdrop />
      <RoomHeader title="" onBack={goHome} />
      <Centered>
        <Animated.View entering={FadeIn} style={styles.messageCard}>
          {busy && <ActivityIndicator color={colors.marigold} size="large" />}
          <Text style={styles.messageTitle} role="heading" aria-level={2}>
            {title}
          </Text>
          {body ? <Text style={styles.messageBody}>{body}</Text> : null}
          <View style={styles.messageButtons}>
            {actions}
            <Button
              variant="secondary"
              label={t('common.backHome')}
              onPress={() => router.replace('/')}
            />
          </View>
          <WakeBanner />
        </Animated.View>
      </Centered>
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    width: '100%',
    maxWidth: CONTENT_MAX,
    alignSelf: 'center',
  },
  back: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  backGlyph: { color: colors.text, fontSize: 30, lineHeight: 32, marginTop: -3 },
  title: { flex: 1, color: colors.text, fontSize: font.heading, fontWeight: '800' },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '700' },
  banners: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: space.lg },
  stage: { flex: 1, width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  match: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
  },
  wakeWrap: { width: '100%', maxWidth: 480, alignSelf: 'center', paddingHorizontal: space.lg },
  muted: { color: colors.textMuted, fontSize: font.body, textAlign: 'center' },
  messageCard: { alignItems: 'center', gap: space.lg, maxWidth: 440, width: '100%' },
  messageTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: '800',
    textAlign: 'center',
  },
  messageBody: { color: colors.textMuted, fontSize: font.body, textAlign: 'center' },
  messageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    justifyContent: 'center',
  },
  reconnecting: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    marginBottom: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: 'rgba(245, 168, 58, 0.45)',
  },
  reconnectingText: { color: colors.text, fontSize: font.small, fontWeight: '700' },
  grace: {
    position: 'absolute',
    top: space.sm,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  graceText: { color: colors.marigold, fontSize: font.small, fontWeight: '700' },
});
