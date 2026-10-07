// Home → "Join with code": a 6-cell code box (auto-uppercase, code alphabet only, paste a code or
// a whole invite link), then GET /rooms/:code → the lobby. ROOM_FULL offers "Watch live".
import { ROOM_CODE_LENGTH } from '@gp/protocol';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { colors, font, radius, space } from '../ui/theme';
import { WakeBanner } from '../ui/WakeBanner';
import { isCompleteCode, sanitizeCodeInput } from './code';
import { resolveJoin, roomHref } from './joinFlow';
import type { JoinErrorCode } from './joinFlow';
import { canPaste, readClipboard } from './share';

const MONO = Platform.select({
  web: 'ui-monospace, Menlo, Consolas, monospace',
  default: undefined,
});

interface CodeInputProps {
  value: string;
  onChange(code: string): void;
  onSubmit(): void;
  label: string;
  invalid: boolean;
}

/** Six visible cells over one real (transparent) TextInput, so typing, paste and IME all work. */
export function CodeInput({ value, onChange, onSubmit, label, invalid }: CodeInputProps) {
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const { width } = useWindowDimensions();
  // Fits 360 px phones (sheet padding included) and caps at 52 px on wide screens.
  const cell = Math.max(
    34,
    Math.min(52, Math.floor((Math.min(width, 560) - 96 - space.sm * 5) / 6)),
  );
  const cells = Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => value[i] ?? '');
  const active = Math.min(value.length, ROOM_CODE_LENGTH - 1);
  return (
    <Pressable
      onPress={() => input.current?.focus()}
      style={styles.codeWrap}
      importantForAccessibility="no"
    >
      <View style={styles.cells} pointerEvents="none">
        {cells.map((char, i) => (
          <View
            key={i}
            style={[
              styles.cell,
              { width: cell, height: cell + 10 },
              char !== '' && styles.cellFilled,
              focused && i === active && styles.cellActive,
              invalid && styles.cellInvalid,
            ]}
          >
            <Text style={[styles.cellText, { fontSize: Math.round(cell * 0.55) }]}>{char}</Text>
          </View>
        ))}
      </View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={(text) => onChange(sanitizeCodeInput(text))}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        returnKeyType="go"
        accessibilityLabel={label}
        aria-invalid={invalid}
        caretHidden
        selectionColor="transparent"
        style={styles.hiddenInput}
        testID="code-input"
      />
    </Pressable>
  );
}

export function JoinSheet({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<JoinErrorCode | 'invalid' | null>(null);
  const [fullRoomId, setFullRoomId] = useState<string | null>(null);

  const join = async (value: string) => {
    if (busy) return;
    if (!isCompleteCode(value)) {
      setError('invalid');
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await resolveJoin(value);
    setBusy(false);
    if (outcome.ok) {
      onClose();
      router.push(roomHref(outcome.roomId));
      return;
    }
    setError(outcome.error);
    setFullRoomId(outcome.roomId ?? null);
  };

  const change = (next: string) => {
    setCode(next);
    setError(null);
    setFullRoomId(null);
  };

  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return;
    const next = sanitizeCodeInput(text);
    change(next);
    if (isCompleteCode(next)) void join(next);
  };

  return (
    <Sheet
      title={t('join.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testID="join-sheet"
      footer={
        <>
          {fullRoomId ? (
            <Button
              big
              label={t('join.watchLive')}
              onPress={() => {
                onClose();
                router.push(roomHref(fullRoomId, true));
              }}
              testID="watch-live"
            />
          ) : (
            <Button
              big
              label={busy ? t('join.checking') : t('join.submit')}
              onPress={() => void join(code)}
              disabled={busy || code.length < ROOM_CODE_LENGTH}
              testID="join-submit"
            />
          )}
          <Button variant="ghost" label={t('common.close')} onPress={onClose} />
        </>
      }
    >
      <Text style={styles.body}>{t('join.body')}</Text>
      <CodeInput
        value={code}
        onChange={change}
        onSubmit={() => void join(code)}
        label={t('join.codeLabel')}
        invalid={error !== null && error !== 'ROOM_FULL'}
      />
      {canPaste() && (
        <View style={styles.pasteRow}>
          <Button variant="secondary" label={t('join.paste')} onPress={() => void paste()} />
        </View>
      )}
      {error && (
        <Text style={styles.error} role="alert" testID="join-error">
          {t(`join.errors.${error}`)}
        </Text>
      )}
      <WakeBanner />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.textMuted, fontSize: font.body, lineHeight: 23 },
  codeWrap: { alignSelf: 'center', position: 'relative' },
  cells: { flexDirection: 'row', gap: space.sm },
  cell: {
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFilled: { borderColor: 'rgba(245, 168, 58, 0.55)' },
  cellActive: { borderColor: colors.marigold, borderWidth: 2.5 },
  cellInvalid: { borderColor: colors.danger },
  cellText: { color: colors.text, fontWeight: '900', fontFamily: MONO },
  hiddenInput: {
    ...StyleSheet.absoluteFill,
    opacity: 0.01,
    color: 'transparent',
    fontSize: 16,
  },
  pasteRow: { alignItems: 'center' },
  error: { color: colors.danger, fontSize: font.small, textAlign: 'center', fontWeight: '600' },
});
