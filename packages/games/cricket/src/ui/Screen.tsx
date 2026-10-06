// Hand Cricket screen. GameHost hands it the redacted view, the engine meta (deadlines in serverNow
// units) and `submit`; the screen never knows whether the opponent is a local bot or the server.
//
// Flow: toss (call odd/even → both throw → winner bats or bowls) → innings 1 → innings break →
// the chase → result. Every reveal: hands pump twice and flick out their fingers (the "thunk"),
// then runs tick on the scoreboard, a SIX bursts confetti, a wicket sends the stumps flying and
// shakes the screen. Motion is shared values on the UI thread; React re-renders once per state.
import type { Seat } from '@gp/game-sdk/core';
import type { EngineMeta } from '@gp/game-sdk/engine';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  ZoomIn,
} from 'react-native-reanimated';

import type { CricketAction, CricketView, Decision, Parity } from '../logic/rules';
import type { ArenaFx } from './Arena';
import { Arena, arenaLayout, shakeSequence } from './Arena';
import { ChoiceRow, PickPad } from './Controls';
import type { Translate } from './i18n';
import { useStrings } from './i18n';
import type { BallFeedback } from './model';
import {
  canPick,
  chaseOf,
  feedbackFor,
  handValues,
  homeSeat,
  isAwaiting,
  otherSeat,
  oversText,
  resultLine,
  roleOf,
  teamLines,
} from './model';
import { IMPACT_AT_MS, REVEAL_AT_MS } from './motion';
import { haptic, useWebKeys } from './platform';
import { Scoreboard } from './Scoreboard';
import { colors, COLUMN_MAX, font, radius, space } from './theme';

type SubmitResult = { ok: true; version: number } | { ok: false; reason: string };

/** Structurally matches the client's GameScreenProps (game UIs don't import the client). */
export interface CricketScreenProps {
  view: CricketView;
  meta: EngineMeta;
  seat: Seat | null;
  submit(action: CricketAction): Promise<SubmitResult>;
  serverNow(): number;
}

interface Size {
  width: number;
  height: number;
}

export function Screen(props: CricketScreenProps) {
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
        ? prev
        : { width, height },
    );
  }, []);
  return (
    <View style={styles.fill} onLayout={onLayout} testID="cricket-screen">
      {size && size.width > 0 && <Match {...props} size={size} />}
    </View>
  );
}

function Match({ view, meta, submit, serverNow, size }: CricketScreenProps & { size: Size }) {
  const t = useStrings();
  const reduceMotion = useReducedMotion();
  const home = homeSeat(view);
  const away = otherSeat(home);
  const names = useMemo(() => {
    const n: Record<number, string> = {};
    n[home] = view.you === null ? 'P1' : t('you');
    n[away] = t('bot');
    return n;
  }, [home, away, view.you, t]);
  const homeName = names[home] ?? '';
  const awayName = names[away] ?? '';

  // Layout: one centred column, the arena takes what the controls leave.
  const columnW = Math.min(size.width - space.md * 2, COLUMN_MAX);
  const compact = size.height < 640 || columnW < 400;
  const short = size.height < 640;
  const arenaH = Math.round(
    Math.max(170, Math.min(columnW, size.height * (short ? 0.36 : 0.46), 400)),
  );

  // ---- local input state ----------------------------------------------------------------------
  const [pending, setPending] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const round = `${view.phase}|${view.current?.number ?? 0}|${view.current?.balls ?? 0}`;
  useEffect(() => setPending(null), [round]);

  const myPick = view.you === null ? null : view.picks[view.you];
  const pickable = canPick(view, pending !== null) && !meta.paused;
  const hands = handValues(view);
  const chosen =
    typeof myPick === 'number' ? myPick : (pending ?? (hands.key !== null ? hands.home : null));

  const pick = (value: number) => {
    if (!pickable) return;
    setPending(value);
    haptic('tap');
    void submit({ type: 'pick', value }).then((ack) => {
      if (!ack.ok) setPending(null);
    });
  };
  const call = (c: Parity) => {
    if (!isAwaiting(view, 'call') || meta.paused) return;
    haptic('tap');
    void submit({ type: 'call', call: c });
  };
  const choose = (d: Decision) => {
    if (!isAwaiting(view, 'choose') || meta.paused) return;
    haptic('tap');
    void submit({ type: 'choose', decision: d });
  };

  const choice: 'call' | 'choose' | null = isAwaiting(view, 'call')
    ? 'call'
    : isAwaiting(view, 'choose')
      ? 'choose'
      : null;

  // ---- reveal effects: feedback text, haptics, shake --------------------------------------------
  const shake = useSharedValue(0);
  const [feedback, setFeedback] = useState<(BallFeedback & { key: string }) | null>(null);
  const lastBall = view.lastBall;
  const fx: ArenaFx | null = useMemo(() => {
    if (hands.key === null) return null;
    if (hands.key === 'toss') return { key: 'toss', kind: 'toss' };
    return lastBall ? { key: hands.key, kind: feedbackFor(view, lastBall).kind } : null;
    // `view` is read for the batter of `lastBall` only; the key covers it.
  }, [hands.key, lastBall]);
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (hands.key === null || hands.key === 'toss' || !lastBall) {
      setFeedback(null);
      if (hands.key === 'toss' && seenKey.current !== 'toss') {
        seenKey.current = 'toss';
        const id = setTimeout(() => haptic('thunk'), reduceMotion ? 0 : REVEAL_AT_MS);
        return () => clearTimeout(id);
      }
      seenKey.current = hands.key;
      return;
    }
    if (seenKey.current === hands.key) return;
    seenKey.current = hands.key;
    const fb = { ...feedbackFor(view, lastBall), key: hands.key };
    const timers = [
      setTimeout(() => haptic('thunk'), reduceMotion ? 0 : REVEAL_AT_MS),
      setTimeout(
        () => {
          setFeedback(fb);
          if (fb.kind === 'out') haptic('wicket');
          else if (fb.kind === 'six') haptic('six');
        },
        reduceMotion ? 0 : IMPACT_AT_MS,
      ),
    ];
    if (fb.kind === 'out') shake.value = shakeSequence(reduceMotion);
    return () => timers.forEach(clearTimeout);
  }, [hands.key]);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  // ---- keyboard (web) -------------------------------------------------------------------------
  const choiceIds =
    choice === 'call' ? ['odd', 'even'] : choice === 'choose' ? ['bat', 'bowl'] : [];
  const runChoice = (id: string | undefined) => {
    if (id === 'odd' || id === 'even') call(id);
    else if (id === 'bat' || id === 'bowl') choose(id);
  };
  useWebKeys((key) => {
    const k = key.toLowerCase();
    if (choice) {
      const hot: Record<string, string> =
        choice === 'call'
          ? { o: 'odd', e: 'even', '1': 'odd', '2': 'even' }
          : { b: 'bat', '1': 'bat', '2': 'bowl' };
      if (hot[k]) {
        runChoice(hot[k]);
        return true;
      }
      if (k === 'arrowleft' || k === 'arrowright') {
        setFocus((f) => (f === 0 ? 1 : 0));
        return true;
      }
      if (k === 'enter' && focus !== null) {
        runChoice(choiceIds[focus === 1 ? 1 : 0]);
        return true;
      }
      return false;
    }
    if (/^[1-6]$/.test(k)) {
      const value = Number(k);
      setFocus((f) => (f === null ? null : value));
      pick(value);
      return true;
    }
    if (k === 'arrowleft' || k === 'arrowright') {
      const step = k === 'arrowleft' ? -1 : 1;
      setFocus((f) => (f === null ? (chosen ?? 3) : ((f - 1 + step + 6) % 6) + 1));
      return true;
    }
    if (k === 'enter' && focus !== null) {
      pick(focus);
      return true;
    }
    return false;
  });
  useEffect(() => {
    // Keep the focus ring meaningful across prompts: choices index from 0, the pad from 1.
    setFocus((f) => (f === null ? null : choice ? 0 : 3));
  }, [choice]);

  // ---- derived text ---------------------------------------------------------------------------
  const [homeLine, awayLine] = teamLines(view);
  const chase = chaseOf(view);
  const status = statusFor(view, t, names, pending, chosen);
  const cur = view.current;
  const L = arenaLayout(columnW, arenaH);
  const badgeY = Math.max(4, L.handY - L.handSize * 1.08 - 52);
  const ringActive =
    meta.awaiting.deadlineAt !== null &&
    view.you !== null &&
    meta.awaiting.seats.includes(view.you) &&
    pending === null &&
    !meta.finished;

  return (
    <Animated.View style={[styles.root, shakeStyle]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.column, { width: columnW, gap: compact ? space.sm : space.md }]}>
          <Scoreboard
            t={t}
            home={homeLine}
            away={awayLine}
            homeName={homeName}
            awayName={awayName}
            oversText={cur ? oversText(cur.balls, view.rules.ballsPerOver) : null}
            totalOvers={view.rules.overs}
            chase={chase}
            thisOver={cur?.thisOver ?? []}
            ballsPerOver={view.rules.ballsPerOver}
            tickDelay={reduceMotion ? 0 : IMPACT_AT_MS}
            reduceMotion={reduceMotion}
            compact={compact}
          />

          <View style={[styles.arena, { width: columnW, height: arenaH }]}>
            <Arena
              width={columnW}
              height={arenaH}
              home={hands.home}
              away={hands.away}
              revealKey={hands.key}
              fx={fx}
              deadlineAt={meta.awaiting.deadlineAt}
              paused={meta.paused}
              ringActive={ringActive}
              serverNow={serverNow}
              reduceMotion={reduceMotion}
            />
            <Text style={[styles.handName, { left: space.sm }]}>{homeName}</Text>
            <Text style={[styles.handName, { right: space.sm }]}>{awayName}</Text>
            {hands.home !== null && hands.key !== null && (
              <HandBadge
                key={`h${hands.key}`}
                value={hands.home}
                x={L.homeX}
                y={badgeY}
                label={t('handLabel', { name: homeName, value: hands.home })}
                testID="cr-hand-home"
                delay={reduceMotion ? 0 : REVEAL_AT_MS}
              />
            )}
            {hands.away !== null && hands.key !== null && (
              <HandBadge
                key={`a${hands.key}`}
                value={hands.away}
                x={L.awayX}
                y={badgeY}
                label={t('handLabel', { name: awayName, value: hands.away })}
                testID="cr-hand-away"
                delay={reduceMotion ? 0 : REVEAL_AT_MS}
              />
            )}
            {(view.phase === 'call' || view.phase === 'toss') && (
              <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.tossPill}>
                <Text style={styles.tossPillText}>{t('tossTitle')}</Text>
              </Animated.View>
            )}
            {feedback && <FeedbackBurst key={feedback.key} fb={feedback} t={t} />}
            {view.phase === 'innings-start' && <InningsSplash view={view} t={t} names={names} />}
            {view.phase === 'done' && view.outcome && (
              <ResultBanner view={view} t={t} awayName={awayName} home={home} />
            )}
          </View>

          <View style={styles.status} accessibilityLiveRegion="polite">
            <Text style={styles.statusTitle} testID="cr-status" numberOfLines={2}>
              {status.title}
            </Text>
            {status.sub ? (
              <Text style={styles.statusSub} numberOfLines={2}>
                {status.sub}
              </Text>
            ) : null}
          </View>

          {view.phase === 'done' ? (
            <Stats view={view} t={t} names={names} home={home} />
          ) : choice ? (
            <ChoiceRow
              options={
                choice === 'call'
                  ? [
                      { id: 'odd', label: t('odd'), testID: 'cr-call-odd', color: colors.rain },
                      { id: 'even', label: t('even'), testID: 'cr-call-even', color: colors.teal },
                    ]
                  : [
                      {
                        id: 'bat',
                        label: t('bat'),
                        testID: 'cr-choose-bat',
                        color: colors.marigold,
                      },
                      {
                        id: 'bowl',
                        label: t('bowl'),
                        testID: 'cr-choose-bowl',
                        color: colors.rain,
                      },
                    ]
              }
              focus={focus}
              enabled={!meta.paused}
              width={columnW}
              onChoose={runChoice}
            />
          ) : (
            <PickPad
              t={t}
              enabled={pickable}
              chosen={chosen}
              focus={focus}
              width={columnW}
              onPick={pick}
            />
          )}

          {Platform.OS === 'web' && !compact && view.phase !== 'done' && (
            <Text style={styles.keys}>
              {choice === 'call'
                ? t('keysHintCall')
                : choice === 'choose'
                  ? t('keysHintChoose')
                  : t('keysHint')}
            </Text>
          )}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

// ---- status line ------------------------------------------------------------------------------

interface Status {
  title: string;
  sub: string | null;
}

function statusFor(
  view: CricketView,
  t: Translate,
  names: Record<number, string>,
  pending: number | null,
  chosen: number | null,
): Status {
  const away = otherSeat(homeSeat(view));
  const awayName = names[away] ?? '';
  const toss = view.toss;
  const caller = names[toss.caller] ?? '';
  const calledLine = toss.call ? t('called', { name: caller, call: t(toss.call) }) : null;
  const locked = (value: number | null) =>
    value === null
      ? t('oppThinking', { name: awayName })
      : t('lockedIn', { value, name: awayName });
  switch (view.phase) {
    case 'call':
      return isAwaiting(view, 'call')
        ? { title: t('callPrompt'), sub: null }
        : { title: t('callWaiting', { name: caller }), sub: null };
    case 'toss':
      return {
        title: calledLine ?? t('tossTitle'),
        sub: canPick(view, pending !== null) ? t('tossThrow') : locked(chosen),
      };
    case 'toss-locked':
    case 'toss-result':
    case 'choose': {
      const throws = toss.throws;
      const sum = throws ? throws.reduce((a, b) => a + b, 0) : 0;
      const sumLine = throws
        ? t('tossSum', {
            a: throws[0] ?? 0,
            b: throws[1] ?? 0,
            sum,
            parity: t(sum % 2 === 1 ? 'odd' : 'even'),
          })
        : null;
      const youWon = toss.winner !== null && toss.winner === view.you;
      const wonLine = youWon
        ? t('tossWonYou')
        : t('tossWonThem', { name: names[toss.winner ?? away] ?? awayName });
      if (view.phase === 'choose') {
        return {
          title: wonLine,
          sub: youWon ? t('choosePrompt') : t('chooseWaiting', { name: awayName }),
        };
      }
      return { title: wonLine, sub: sumLine };
    }
    case 'innings-start':
    case 'ball':
    case 'ball-locked':
    case 'ball-result': {
      const role = roleOf(view);
      const title = role === 'bat' ? t('roleBat') : role === 'bowl' ? t('roleBowl') : t('innings1');
      if (view.phase === 'ball' && canPick(view, pending !== null)) {
        return { title: t('pickNow'), sub: role === 'bowl' ? t('hintBowl') : t('hintBat') };
      }
      if (view.phase === 'ball' || view.phase === 'ball-locked') {
        return { title, sub: locked(chosen) };
      }
      return { title, sub: role === 'bowl' ? t('hintBowl') : t('hintBat') };
    }
    case 'done': {
      const outcome = view.outcome;
      if (!outcome) return { title: t('resultTitle'), sub: null };
      const r = resultLine(outcome, homeSeat(view));
      return {
        title: r.key === 'tie' ? t('tie') : t(r.key, { count: r.count, name: awayName }),
        sub: null,
      };
    }
  }
}

// ---- overlays ---------------------------------------------------------------------------------

function HandBadge({
  value,
  x,
  y,
  label,
  testID,
  delay,
}: {
  value: number;
  x: number;
  y: number;
  label: string;
  testID: string;
  delay: number;
}) {
  return (
    <Animated.View
      entering={ZoomIn.delay(delay).springify().damping(10)}
      style={[styles.badge, { left: x - 22, top: y }]}
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={styles.badgeText}>{value}</Text>
    </Animated.View>
  );
}

function FeedbackBurst({ fb, t }: { fb: BallFeedback & { key: string }; t: Translate }) {
  const good =
    fb.kind === 'out' ? fb.youBatted === false : fb.youBatted !== false || fb.kind === 'runs';
  const text =
    fb.kind === 'out'
      ? fb.youBatted === false
        ? t('wicket')
        : t('out')
      : fb.kind === 'six'
        ? t('six')
        : fb.kind === 'four'
          ? t('four')
          : t('runs', { count: fb.runs });
  const color =
    fb.kind === 'out'
      ? good
        ? colors.success
        : colors.kumkum
      : fb.kind === 'six'
        ? colors.marigold
        : fb.kind === 'four'
          ? colors.teal
          : colors.text;
  const big = fb.kind !== 'runs';
  return (
    <Animated.View
      entering={ZoomIn.springify().damping(9).stiffness(220)}
      exiting={FadeOut.duration(180)}
      style={styles.feedback}
      pointerEvents="none"
    >
      <Text
        style={[styles.feedbackText, { color, fontSize: big ? 46 : 32 }]}
        testID="cr-feedback"
        accessibilityLiveRegion="assertive"
      >
        {text}
      </Text>
    </Animated.View>
  );
}

function InningsSplash({
  view,
  t,
  names,
}: {
  view: CricketView;
  t: Translate;
  names: Record<number, string>;
}) {
  const cur = view.current;
  if (!cur) return null;
  const first = view.innings[0];
  const lines: string[] = [];
  let title: string;
  if (cur.number === 1) {
    title = t('innings1');
    lines.push(cur.batter === view.you ? t('youBatFirst') : t('youBowlFirst'));
  } else {
    title = t('inningsBreak');
    if (first) {
      lines.push(
        t('firstInningsScore', {
          name: names[first.batter] ?? '',
          runs: first.runs,
          wickets: first.wickets,
        }),
      );
    }
    const target = cur.target ?? 0;
    lines.push(
      cur.batter === view.you
        ? t('youChase', { target })
        : t('theyChase', { name: names[cur.batter] ?? '', target }),
    );
  }
  return (
    <Animated.View
      entering={FadeInDown.springify().damping(14)}
      exiting={FadeOut.duration(200)}
      style={styles.splash}
      testID="cr-splash"
    >
      <Text style={styles.splashTitle}>{title}</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.splashLine}>
          {line}
        </Text>
      ))}
    </Animated.View>
  );
}

function ResultBanner({
  view,
  t,
  awayName,
  home,
}: {
  view: CricketView;
  t: Translate;
  awayName: string;
  home: Seat;
}) {
  if (!view.outcome) return null;
  const r = resultLine(view.outcome, home);
  const text = r.key === 'tie' ? t('tie') : t(r.key, { count: r.count, name: awayName });
  const color = r.won === null ? colors.teal : r.won ? colors.marigold : colors.rain;
  return (
    <Animated.View
      entering={ZoomIn.delay(IMPACT_AT_MS + 500)
        .springify()
        .damping(12)}
      style={[styles.banner, { borderColor: color }]}
      testID="cr-result"
    >
      <Text style={[styles.bannerText, { color }]}>{text}</Text>
    </Animated.View>
  );
}

function Stats({
  view,
  t,
  names,
  home,
}: {
  view: CricketView;
  t: Translate;
  names: Record<number, string>;
  home: Seat;
}) {
  const seats: Seat[] = [home, otherSeat(home)];
  const rows: { label: string; values: (number | string)[] }[] = [
    { label: t('statRuns'), values: seats.map((s) => view.stats[s]?.runs ?? 0) },
    { label: t('statBalls'), values: seats.map((s) => view.stats[s]?.ballsFaced ?? 0) },
    { label: t('statSixes'), values: seats.map((s) => view.stats[s]?.sixes ?? 0) },
    { label: t('statWickets'), values: seats.map((s) => view.stats[s]?.wicketsTaken ?? 0) },
    { label: t('statDucks'), values: seats.map((s) => view.stats[s]?.ducks ?? 0) },
  ];
  return (
    <Animated.View
      entering={FadeInDown.delay(IMPACT_AT_MS + 300)}
      style={styles.stats}
      testID="cr-stats"
    >
      <View style={styles.statsRow}>
        <Text style={[styles.statLabel, styles.statHead]} />
        {seats.map((s) => (
          <Text key={s} style={[styles.statValue, styles.statHead]}>
            {names[s]}
          </Text>
        ))}
      </View>
      {view.innings.map((inn) => (
        <View key={`i${inn.number}`} style={styles.statsRow}>
          <Text style={styles.statLabel}>{t(inn.number === 1 ? 'innings1' : 'innings2')}</Text>
          {seats.map((s) => (
            <Text key={s} style={[styles.statValue, s === inn.batter && styles.statStrong]}>
              {s === inn.batter
                ? t('scoreLine', {
                    runs: inn.runs,
                    wickets: inn.wickets,
                    overs: oversText(inn.balls, view.rules.ballsPerOver),
                  })
                : '–'}
            </Text>
          ))}
        </View>
      ))}
      {rows.map((row) => (
        <View key={row.label} style={styles.statsRow}>
          <Text style={styles.statLabel}>{row.label}</Text>
          {row.values.map((v, i) => (
            <Text key={i} style={styles.statValue}>
              {v}
            </Text>
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%' },
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, alignItems: 'center', paddingVertical: space.sm },
  column: { alignItems: 'stretch' },
  arena: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.bgDeep,
    borderWidth: 1,
    borderColor: colors.border,
  },
  handName: {
    position: 'absolute',
    bottom: 6,
    color: colors.text,
    fontSize: font.tiny,
    fontWeight: '900',
    backgroundColor: 'rgba(9,12,22,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  badge: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.ink,
  },
  badgeText: { color: colors.ink, fontSize: 24, fontWeight: '900' },
  tossPill: {
    position: 'absolute',
    top: space.sm,
    alignSelf: 'center',
    backgroundColor: 'rgba(9,12,22,0.7)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.marigold,
  },
  tossPillText: {
    color: colors.marigold,
    fontWeight: '900',
    letterSpacing: 2,
    fontSize: font.tiny,
  },
  feedback: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '4%',
    alignItems: 'center',
  },
  feedbackText: {
    fontWeight: '900',
    letterSpacing: 1,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  splash: {
    position: 'absolute',
    alignSelf: 'center',
    top: '14%',
    backgroundColor: 'rgba(9,12,22,0.82)',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.marigold,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    alignItems: 'center',
    gap: 4,
    maxWidth: '90%',
  },
  splashTitle: { color: colors.marigold, fontSize: font.title, fontWeight: '900' },
  splashLine: { color: colors.text, fontSize: font.body, fontWeight: '700', textAlign: 'center' },
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    top: '40%',
    backgroundColor: 'rgba(9,12,22,0.86)',
    borderRadius: radius.lg,
    borderWidth: 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    maxWidth: '92%',
  },
  bannerText: { fontSize: font.title, fontWeight: '900', textAlign: 'center' },
  status: { alignItems: 'center', minHeight: 46, justifyContent: 'center', gap: 2 },
  statusTitle: {
    color: colors.text,
    fontSize: font.heading,
    fontWeight: '800',
    textAlign: 'center',
  },
  statusSub: { color: colors.textMuted, fontSize: font.small, textAlign: 'center' },
  keys: { color: colors.textDim, fontSize: font.tiny, textAlign: 'center' },
  stats: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: 6,
  },
  statsRow: { flexDirection: 'row', alignItems: 'center' },
  statLabel: { flex: 1.4, color: colors.textMuted, fontSize: font.small, fontWeight: '700' },
  statHead: { color: colors.text, fontWeight: '900' },
  statValue: {
    flex: 1,
    color: colors.text,
    fontSize: font.small,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  statStrong: { color: colors.marigold, fontWeight: '900' },
});
