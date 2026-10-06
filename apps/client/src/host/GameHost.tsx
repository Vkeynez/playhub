// GameHost (ARCHITECTURE §3.7, §6.3): resolves a game from the registry, shows the pre-game sheet,
// loads Skia (web, Skia games only) and the game's UI chunk, runs a LocalRoom (human seat 0 vs
// bots) and renders the game's Screen. Result sheet with rematch; pauses while backgrounded.
import type { AnyGameModule, GameEvent } from '@gp/game-sdk/core';
import { router } from 'expo-router';
import { Component, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getGame } from '../registry';
import { UiNotReadyError } from '../registry/games';
import { LocalRoom } from '../room/LocalRoom';
import type { GameRegistration, GameScreenProps, GameUiModule } from '../room/types';
import { ensureSkia, useSkiaStatus } from '../skia';
import { Backdrop } from '../ui/Backdrop';
import { Button } from '../ui/Button';
import { GameArt } from '../ui/GameArt';
import { colors, CONTENT_MAX, font, radius, space, TOUCH } from '../ui/theme';
import { configOptions } from './configOptions';
import { ResultSheet, outcomeFor } from './ResultSheet';
import { SetupSheet } from './SetupSheet';
import type { MatchSettings } from './SetupSheet';

type AnyRoom = LocalRoom<unknown, unknown, unknown, unknown, GameEvent>;
type Phase = 'setup' | 'starting' | 'playing' | 'not-ready' | 'error';

/** How long the final move animates before the result sheet slides up. */
const RESULT_DELAY_MS = 1100;

function goHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function GameHost({ gameId }: { gameId: string }) {
  const { t } = useTranslation();
  const registration = getGame(gameId);
  if (!registration) {
    return <HostMessage gameId={gameId} title={t('host.unknownGame')} />;
  }
  return <RegisteredHost key={gameId} registration={registration} />;
}

function RegisteredHost({ registration }: { registration: GameRegistration }) {
  const { t } = useTranslation();
  const { manifest } = registration;
  const [logic, setLogic] = useState<AnyGameModule | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [settings, setSettings] = useState<MatchSettings | null>(null);
  const [ui, setUi] = useState<GameUiModule | null>(null);
  const [room, setRoom] = useState<AnyRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matchNo, setMatchNo] = useState(0);
  const skiaStatus = useSkiaStatus();

  useEffect(() => {
    let live = true;
    registration.logic().then(
      (module) => live && setLogic(module),
      (e: unknown) => {
        if (!live) return;
        setError(String(e));
        setPhase('error');
      },
    );
    return () => {
      live = false;
    };
  }, [registration]);

  // Dispose the previous room whenever it is replaced, and on unmount.
  useEffect(() => () => room?.dispose(), [room]);

  // Freeze game time while the app is backgrounded / the tab is hidden (§6.3).
  useEffect(() => {
    if (!room) return;
    room.setActive(AppState.currentState === 'active' || AppState.currentState == null);
    const sub = AppState.addEventListener('change', (s) => room.setActive(s === 'active'));
    return () => sub.remove();
  }, [room]);

  const options = useMemo(() => (logic ? configOptions(logic.configSchema) : []), [logic]);

  const createRoom = useCallback((module: AnyGameModule, s: MatchSettings) => {
    setMatchNo((n) => n + 1);
    setRoom(
      new LocalRoom(module, {
        mode: s.mode,
        config: s.config,
        botLevel: s.botLevel,
        humanSeat: s.seat,
        onError: (e) => {
          setError(String(e));
          setPhase('error');
        },
      }),
    );
  }, []);

  const start = useCallback(
    async (s: MatchSettings) => {
      if (!logic) return;
      setSettings(s);
      setPhase('starting');
      try {
        if (registration.usesSkia) await ensureSkia();
        const loaded = ui ?? (await registration.load());
        await loaded.loadAssets?.();
        setUi(loaded);
        createRoom(logic, s);
        setPhase('playing');
      } catch (e) {
        if (e instanceof UiNotReadyError) setPhase('not-ready');
        else {
          setError(String(e));
          setPhase('error');
        }
      }
    },
    [createRoom, logic, registration, ui],
  );

  const name = t(manifest.name);

  if (phase === 'not-ready') {
    return (
      <HostMessage
        gameId={manifest.id}
        title={t('host.notReady', { name })}
        body={t('host.notReadyBody')}
      />
    );
  }
  if (phase === 'error') {
    return (
      <HostMessage
        gameId={manifest.id}
        title={t('host.error')}
        body={t('host.errorBody')}
        detail={error}
        onRetry={() => {
          setError(null);
          setRoom(null);
          setPhase('setup');
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <Backdrop />
      <HostHeader title={name} chip={settings ? t(`setup.level.${settings.botLevel}`) : null} />
      <View style={styles.stage}>
        {phase === 'playing' && room && ui && settings ? (
          <Match
            key={matchNo}
            room={room}
            ui={ui}
            settings={settings}
            onRematch={() => logic && createRoom(logic, settings)}
            onSettings={() => {
              setRoom(null);
              setPhase('setup');
            }}
          />
        ) : phase === 'starting' || !logic ? (
          <Centered>
            <ActivityIndicator color={colors.marigold} size="large" />
            <Text style={styles.muted}>
              {skiaStatus === 'loading' ? t('host.loadingSkia') : t('common.loading')}
            </Text>
          </Centered>
        ) : (
          <Centered>
            <View style={styles.heroArt}>
              <GameArt id={manifest.id} size={160} />
            </View>
          </Centered>
        )}
      </View>
      {phase === 'setup' && logic && (
        <SetupSheet
          manifest={manifest}
          options={options}
          seatLabels={registration.seatChoice?.labels}
          initial={settings}
          onStart={(s) => void start(s)}
          onClose={goHome}
        />
      )}
    </View>
  );
}

interface MatchProps {
  room: AnyRoom;
  ui: GameUiModule;
  settings: MatchSettings;
  onRematch(): void;
  onSettings(): void;
}

function Match({ room, ui, settings, onRematch, onSettings }: MatchProps) {
  const { t } = useTranslation();
  const subscribe = useCallback((fn: () => void) => room.subscribe(fn), [room]);
  const getState = useCallback(() => room.getState(), [room]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const submit = useCallback((action: unknown) => room.submit(action), [room]);
  const serverNow = useCallback(() => room.serverNow(), [room]);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    setShowResult(false);
    if (!state.result) return;
    const id = setTimeout(() => setShowResult(true), RESULT_DELAY_MS);
    return () => clearTimeout(id);
  }, [state.result]);

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
          mode={settings.mode}
          config={settings.config}
          botLevel={settings.botLevel}
        />
      </ScreenBoundary>
      {state.meta.paused && !state.meta.finished && (
        <Animated.View entering={FadeIn} style={styles.paused} pointerEvents="none">
          <Text style={styles.pausedTitle}>{t('common.paused')}</Text>
          <Text style={styles.muted}>{t('host.pausedBody')}</Text>
        </Animated.View>
      )}
      {showResult && state.result && (
        <ResultSheet
          outcome={outcomeFor(state.result, room.seat)}
          onRematch={onRematch}
          onSettings={onSettings}
          onHome={goHome}
        />
      )}
    </View>
  );
}

function HostHeader({ title, chip }: { title: string; chip: string | null }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <Pressable
        onPress={goHome}
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
      {chip && (
        <View style={styles.chip}>
          <Text style={styles.chipText}>
            {t('common.bot')} · {chip}
          </Text>
        </View>
      )}
    </View>
  );
}

function HostMessage({
  gameId,
  title,
  body,
  detail,
  onRetry,
}: {
  gameId: string;
  title: string;
  body?: string;
  detail?: string | null;
  onRetry?(): void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.root}>
      <Backdrop />
      <HostHeader title="" chip={null} />
      <Centered>
        <View style={styles.heroArt}>
          <GameArt id={gameId} size={120} />
        </View>
        <Text style={styles.messageTitle} role="heading" aria-level={2}>
          {title}
        </Text>
        {body && <Text style={styles.messageBody}>{body}</Text>}
        {detail && __DEV__ && <Text style={styles.detail}>{detail}</Text>}
        <View style={styles.messageButtons}>
          {onRetry && <Button label={t('common.retry')} onPress={onRetry} />}
          <Button variant="secondary" label={t('common.backHome')} onPress={goHome} />
        </View>
      </Centered>
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

class ScreenBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('game screen crashed', error);
  }
  override render() {
    return this.state.failed ? <Centered>{this.props.fallback}</Centered> : this.props.children;
  }
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
  stage: { flex: 1, width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
  match: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
  },
  heroArt: {
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: 'rgba(30, 38, 64, 0.6)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  muted: { color: colors.textMuted, fontSize: font.body, textAlign: 'center' },
  paused: {
    position: 'absolute',
    top: space.lg,
    alignSelf: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
  },
  pausedTitle: { color: colors.text, fontSize: font.heading, fontWeight: '800' },
  messageTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: '800',
    textAlign: 'center',
  },
  messageBody: { color: colors.textMuted, fontSize: font.body, textAlign: 'center', maxWidth: 420 },
  detail: { color: colors.danger, fontSize: font.tiny, maxWidth: 480 },
  messageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    justifyContent: 'center',
  },
});
