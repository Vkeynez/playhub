// Tamil shaping check: the same strings through Skia Paragraph (HarfBuzz shaping, bundled Noto Sans
// Tamil), Skia Text (no shaping: one glyph per code point, expected to break vowel signs and
// conjuncts) and RN <Text> (platform shaping, system font). Visual check via screenshot, plus a
// numeric signal: shaped vs unshaped advance width per string (Latin should match, Tamil should not).
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  Canvas,
  Paragraph,
  Skia,
  Text as SkText,
  useFont,
  useFonts,
} from '@shopify/react-native-skia';
import type { SkParagraph } from '@shopify/react-native-skia';

// On Expo web `require()` of a font yields a URL string, which Skia 2.6.2's useFonts/resolveAsset
// rejects ("Cannot use 'in' operator to search for 'uri'"). Wrap it in the MetroAsset shape.
const FONT_MODULE: unknown = require('../../assets/fonts/NotoSansTamil-VF.ttf');
const FONT =
  typeof FONT_MODULE === 'string'
    ? { uri: FONT_MODULE, width: 0, height: 0 }
    : (FONT_MODULE as number);

// Two-part vowel signs (கொ கோ கௌ reorder around the consonant), pulli (்), the ஸ்ரீ and க்ஷ
// conjuncts, and an ordinary sentence. Plus a Latin control.
export const SAMPLES = [
  'தமிழ் விளையாட்டு',
  'கொ கோ கௌ ஸ்ரீ க்ஷ',
  'வணக்கம்! நீங்கள் வெற்றி பெற்றீர்கள்',
  'Score 1234 / Timer 0:59',
];

export interface TamilReport {
  fontLoaded: boolean;
  rows: Array<{
    text: string;
    shapedWidth: number;
    unshapedWidth: number;
    ratio: number;
    missingGlyphs: number;
  }>;
}

const SIZE = 24;
const ROW_H = 44;

/** Stack paragraphs by their laid-out height (a long line wraps). */
function paragraphY(ps: SkParagraph[], i: number): number {
  let y = 8;
  for (let k = 0; k < i; k++) y += Math.max(ROW_H, ps[k].getHeight() + 8);
  return y;
}

export function TamilScreen({ onDone }: { onDone?: (r: TamilReport) => void }) {
  const { width } = useWindowDimensions();
  const fontMgr = useFonts({ NotoSansTamil: [FONT] });
  const font = useFont(FONT, SIZE);
  const [reported, setReported] = useState(false);

  const paragraphs = useMemo(() => {
    if (!fontMgr) return null;
    return SAMPLES.map((text) => {
      // The style is pushed explicitly: CanvasKit (web) ignores ParagraphStyle.textStyle (it drew black
      // 14 px text), while native honours both.
      const style = {
        color: Skia.Color('#ffffff'),
        fontFamilies: ['NotoSansTamil'],
        fontSize: SIZE,
      };
      const p = Skia.ParagraphBuilder.Make({ textStyle: style }, fontMgr)
        .pushStyle(style)
        .addText(text)
        .pop()
        .build();
      p.layout(width - 24);
      return p;
    });
  }, [fontMgr, width]);

  useEffect(() => {
    if (!paragraphs || !font || reported) return;
    const rows = SAMPLES.map((text, i) => {
      const shapedWidth = paragraphs[i].getMaxIntrinsicWidth();
      const unshapedWidth = font.getTextWidth(text); // measureText is not implemented on web
      const ids = font.getGlyphIDs(text);
      return {
        text,
        shapedWidth: Math.round(shapedWidth * 10) / 10,
        unshapedWidth: Math.round(unshapedWidth * 10) / 10,
        ratio: Math.round((shapedWidth / unshapedWidth) * 1000) / 1000,
        missingGlyphs: ids.filter((g, k) => g === 0 && text.codePointAt(k) !== 0x20).length,
      };
    });
    const t = setTimeout(() => {
      setReported(true);
      onDone?.({ fontLoaded: true, rows });
    }, 1500);
    return () => clearTimeout(t);
  }, [paragraphs, font, reported, onDone]);

  const canvasH = (SAMPLES.length * 2 + 1) * ROW_H + 40;
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content} testID="tamil">
      <Text style={styles.h}>
        Skia Paragraph (Noto Sans Tamil, shaped) / Skia Text (same font, unshaped)
      </Text>
      <Canvas style={{ width, height: canvasH }}>
        {paragraphs?.map((p, i) => (
          <Paragraph
            key={`p${i}`}
            paragraph={p}
            x={12}
            y={paragraphY(paragraphs, i)}
            width={width - 24}
          />
        ))}
        {font
          ? SAMPLES.map((text, i) => (
              <SkText
                key={`t${i}`}
                text={text}
                font={font}
                x={12}
                y={40 + (SAMPLES.length + 1) * ROW_H + i * ROW_H + SIZE}
                color="#ff9a9a"
              />
            ))
          : null}
      </Canvas>
      <Text style={styles.h}>RN Text (platform shaping, system font)</Text>
      <View>
        {SAMPLES.map((text) => (
          <Text key={text} style={styles.rn}>
            {text}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#14141c' },
  content: { paddingBottom: 24 },
  h: { color: '#9fd', fontSize: 12, margin: 8 },
  rn: { color: '#ffffff', fontSize: SIZE, marginHorizontal: 12, marginVertical: 6 },
});
