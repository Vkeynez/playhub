// The lobby (BUILD_BRIEF §6.2, §6.3; ARCHITECTURE §6.5): the room code, invites (WhatsApp first,
// then copy / share / QR), seat cards, Ready, host-only Start, Leave.
import type { RoomSnapshot, SeatState } from '@gp/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { joinUrl } from '../net/config';
import type { RemoteRoom } from '../room/RemoteRoom';
import { Button } from '../ui/Button';
import { InAppHint } from '../ui/InAppHint';
import { colors, CONTENT_MAX, font, radius, space } from '../ui/theme';
import { Avatar } from './Avatar';
import { QrCode } from './QrCode';
import { canCopy, canShare, copyText, openWhatsApp, shareInvite } from './share';
import { useNow } from './useNow';

const MONO = Platform.select({
  web: 'ui-monospace, Menlo, Consolas, monospace',
  default: undefined,
});

export type PreloadState = 'loading' | 'loaded' | 'not-ready' | 'error';

interface LobbyProps {
  room: RemoteRoom;
  snapshot: RoomSnapshot;
  gameName: string;
  preload: PreloadState;
  onLeave(): void;
}

export function occupantName(seat: SeatState, t: (key: string, o?: object) => string): string {
  const o = seat.occupant;
  if (!o) return '';
  return o.kind === 'human' ? o.name : t('lobby.bot');
}

export function Lobby({ room, snapshot, gameName, preload, onLeave }: LobbyProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= 820;
  const mySeat = snapshot.yourSeat;
  const me = snapshot.seats.find((s) => s.seat === mySeat) ?? null;
  const isHost = me?.isHost ?? false;
  const allFilled = snapshot.seats.every((s) => s.occupant !== null);
  const allReady = snapshot.seats.every((s) => s.occupant?.kind === 'bot' || s.ready);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedSent = useRef(false);

  // Tell the server this seat has the game chunk (and CanvasKit) loaded (ARCHITECTURE §6.5).
  useEffect(() => {
    if (preload !== 'loaded' || !me || me.loaded || loadedSent.current) return;
    loadedSent.current = true;
    void room.setReady(me.ready, true).then((ack) => {
      if (!ack.ok) loadedSent.current = false;
    });
  }, [preload, me, room]);

  const toggleReady = async () => {
    if (!me) return;
    setBusy(true);
    const ack = await room.setReady(!me.ready, preload === 'loaded');
    setBusy(false);
    if (!ack.ok) setNotice(t('join.errors.generic'));
  };

  const start = async () => {
    setBusy(true);
    const ack = await room.startMatch();
    setBusy(false);
    if (!ack.ok) setNotice(t('lobby.startHint'));
  };

  const invite = (
    <InvitePanel code={snapshot.code} gameName={gameName} compact={!wide} onCopied={setNotice} />
  );
  const seats = (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} role="heading" aria-level={2}>
          {t('lobby.players')}
        </Text>
        {snapshot.spectators > 0 && (
          <Text style={styles.muted}>{t('lobby.spectators', { count: snapshot.spectators })}</Text>
        )}
      </View>
      {snapshot.seats.map((seat, i) => (
        <Animated.View key={seat.seat} entering={FadeInDown.delay(60 * i).duration(300)}>
          <SeatCard
            seat={seat}
            mine={seat.seat === mySeat}
            graceAt={
              snapshot.deadlines.find((d) => d.kind === 'grace' && d.seats.includes(seat.seat))
                ?.at ?? null
            }
            serverNow={() => room.serverNow()}
          />
        </Animated.View>
      ))}
    </View>
  );

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.column, wide && styles.columnWide]}>
          <InAppHint code={snapshot.code} />
          {wide ? (
            <View style={styles.twoCol}>
              <View style={styles.colLeft}>{invite}</View>
              <View style={styles.colRight}>{seats}</View>
            </View>
          ) : (
            <>
              {invite}
              {seats}
              <View style={styles.card}>
                <QrBlock url={joinUrl(snapshot.code)} size={176} />
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <View style={styles.actions}>
        <View style={styles.actionsInner}>
          {notice && (
            <Text style={styles.notice} accessibilityLiveRegion="polite" role="status">
              {notice}
            </Text>
          )}
          {mySeat === null ? (
            <Text style={styles.status}>{t('lobby.spectating')}</Text>
          ) : preload === 'loading' ? (
            <Text style={styles.status}>{t('lobby.loadingGame')}</Text>
          ) : isHost ? (
            <Text style={styles.status}>{allFilled && allReady ? '' : t('lobby.startHint')}</Text>
          ) : me?.ready ? (
            <Text style={styles.status}>{t('lobby.waitingHost')}</Text>
          ) : null}
          <View style={styles.actionRow}>
            {me && (
              <Button
                big
                variant={isHost || me.ready ? 'secondary' : 'primary'}
                label={me.ready ? `${t('lobby.ready')} ✓` : t('lobby.imReady')}
                {...(me.ready ? { accessibilityHint: t('lobby.cancelReady') } : {})}
                onPress={() => void toggleReady()}
                disabled={busy || preload !== 'loaded'}
                selected={me.ready}
                style={styles.flex}
                testID="ready"
              />
            )}
            {isHost && (
              <Button
                big
                label={t('lobby.start')}
                onPress={() => void start()}
                disabled={busy || !allFilled || !allReady}
                style={styles.flex}
                testID="start-match"
              />
            )}
          </View>
          <Button variant="ghost" label={t('lobby.leave')} onPress={onLeave} testID="leave" />
        </View>
      </View>
    </View>
  );
}

function spell(code: string): string {
  return code.split('').join(' ');
}

function InvitePanel({
  code,
  gameName,
  compact,
  onCopied,
}: {
  code: string;
  gameName: string;
  compact: boolean;
  onCopied(message: string): void;
}) {
  const { t } = useTranslation();
  const url = joinUrl(code);
  const text = t('lobby.inviteText', { game: gameName, code });
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t('lobby.codeLabel')}</Text>
      <Text
        style={styles.code}
        selectable
        accessibilityLabel={t('lobby.codeA11y', { spelled: spell(code) })}
        testID="room-code"
      >
        {code}
      </Text>
      <Text style={styles.cardTitle} role="heading" aria-level={2}>
        {t('lobby.invite')}
      </Text>
      <Button
        big
        label={t('lobby.whatsapp')}
        icon={<Text style={styles.waIcon}>●</Text>}
        onPress={() => void openWhatsApp(`${text} ${url}`)}
        testID="invite-whatsapp"
      />
      <View style={styles.shareRow}>
        {canCopy() && (
          <Button
            variant="secondary"
            label={t('lobby.copy')}
            onPress={() => void copyText(url).then((ok) => ok && onCopied(t('lobby.copied')))}
            style={styles.flex}
            testID="copy-link"
          />
        )}
        {canShare() && (
          <Button
            variant="secondary"
            label={t('lobby.share')}
            onPress={() => void shareInvite(gameName, text, url)}
            style={styles.flex}
            testID="share"
          />
        )}
      </View>
      {!compact && <QrBlock url={url} size={200} />}
    </View>
  );
}

function QrBlock({ url, size }: { url: string; size: number }) {
  const { t } = useTranslation();
  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.qrWrap}>
      <View style={styles.qrFrame}>
        <QrCode value={url} size={size} label={t('lobby.qrLabel')} />
      </View>
      <Text style={styles.muted}>{t('lobby.qrHint')}</Text>
    </Animated.View>
  );
}

const DOT: Record<string, string> = {
  connected: colors.success,
  away: colors.marigold,
  reconnecting: colors.marigold,
  disconnected: colors.textDim,
};

function SeatCard({
  seat,
  mine,
  graceAt,
  serverNow,
}: {
  seat: SeatState;
  mine: boolean;
  graceAt: number | null;
  serverNow(): number;
}) {
  const { t } = useTranslation();
  const now = useNow(graceAt !== null ? 1000 : null, serverNow);
  const o = seat.occupant;
  if (!o) {
    return (
      <View style={[styles.seat, styles.seatEmpty]} testID={`seat-${seat.seat}`}>
        <View style={styles.emptyAvatar} />
        <Text style={styles.muted}>{t('lobby.emptySeat')}</Text>
      </View>
    );
  }
  const human = o.kind === 'human';
  const name = human ? o.name : t('lobby.bot');
  const connection = human ? o.connection : 'connected';
  const readyLabel = seat.ready || !human ? t('lobby.ready') : t('lobby.notReady');
  const graceSeconds = graceAt !== null ? Math.max(0, Math.ceil((graceAt - now) / 1000)) : null;
  return (
    <View
      style={[styles.seat, mine && styles.seatMine]}
      accessible
      accessibilityLabel={t('lobby.seatA11y', {
        seat: seat.seat + 1,
        name,
        connection: t(`lobby.connection.${connection}`),
        ready: readyLabel,
      })}
      testID={`seat-${seat.seat}`}
    >
      <View>
        <Avatar seed={human ? o.avatarSeed : `bot-${seat.seat}`} name={name} />
        <View style={[styles.dot, { backgroundColor: DOT[connection] ?? colors.textDim }]} />
      </View>
      <View style={styles.seatText}>
        <Text style={styles.seatName} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.badges}>
          {mine && <Badge label={t('common.you')} color={colors.teal} />}
          {seat.isHost && <Badge label={t('lobby.host')} color={colors.marigold} />}
          {human && <Badge label={t(`lobby.platform.${o.platform}`)} color={colors.rain} />}
          {!human && o.playingFor && <Badge label={t('lobby.bot')} color={colors.lavender} />}
          <Text style={styles.connection}>{t(`lobby.connection.${connection}`)}</Text>
        </View>
        {graceSeconds !== null && (
          <Text style={styles.grace}>{t('lobby.grace', { name, seconds: graceSeconds })}</Text>
        )}
      </View>
      <View
        style={[styles.tick, (seat.ready || !human) && styles.tickOn]}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Text style={[styles.tickText, (seat.ready || !human) && styles.tickTextOn]}>✓</Text>
      </View>
    </View>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: space.xl },
  column: { width: '100%', maxWidth: 560, gap: space.lg },
  columnWide: { maxWidth: CONTENT_MAX - space.lg * 2 },
  twoCol: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' },
  colLeft: { flex: 1, maxWidth: 440 },
  colRight: { flex: 1.2 },
  card: {
    backgroundColor: 'rgba(30, 38, 64, 0.72)',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space.lg,
    gap: space.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, fontSize: font.heading, fontWeight: '800' },
  label: {
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
  },
  code: {
    color: colors.marigold,
    fontSize: 44,
    lineHeight: 52,
    fontWeight: '900',
    letterSpacing: 6,
    textAlign: 'center',
    fontFamily: MONO,
  },
  waIcon: { color: '#25d366', fontSize: 14 },
  shareRow: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  qrWrap: { alignItems: 'center', gap: space.sm, paddingTop: space.xs },
  qrFrame: { padding: space.sm, backgroundColor: '#ffffff', borderRadius: radius.md },
  muted: { color: colors.textMuted, fontSize: font.small, textAlign: 'center' },
  seat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 72,
  },
  seatMine: { borderColor: 'rgba(245, 168, 58, 0.5)' },
  seatEmpty: {
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  emptyAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
  },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.surfaceRaised,
  },
  seatText: { flex: 1, gap: 4 },
  seatName: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 },
  badgeText: { fontSize: font.tiny, fontWeight: '800' },
  connection: { color: colors.textDim, fontSize: font.tiny },
  grace: { color: colors.marigold, fontSize: font.tiny, fontWeight: '700' },
  tick: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { borderColor: colors.success, backgroundColor: 'rgba(98, 210, 154, 0.16)' },
  tickText: { color: colors.textDim, fontSize: 16, fontWeight: '900' },
  tickTextOn: { color: colors.success },
  actions: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(14, 18, 32, 0.94)',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    alignItems: 'center',
  },
  actionsInner: { width: '100%', maxWidth: 560, gap: space.sm },
  actionRow: { flexDirection: 'row', gap: space.sm },
  status: { color: colors.textMuted, fontSize: font.small, textAlign: 'center', minHeight: 18 },
  notice: { color: colors.marigold, fontSize: font.small, textAlign: 'center', fontWeight: '700' },
});
