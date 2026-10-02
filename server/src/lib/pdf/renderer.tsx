import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Font, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { DocumentProps } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { formatIndianNumber } from '@tb/shared';
import { logger } from '../logger.js';

/**
 * Shared PDF plumbing: font registration, styles, and money formatting that is
 * safe on a page.
 *
 * **The ₹ problem, which bites everybody once.** The fonts built into
 * @react-pdf/renderer (Helvetica and friends) have no glyph for U+20B9, so a ₹
 * renders as a blank box — and you discover it the night before submission. Two
 * ways out, and this file takes both:
 *
 *   1. Drop a Unicode TTF at `server/assets/fonts/NotoSans-Regular.ttf` (plus
 *      `-Bold`) and it is registered automatically; `money()` then prints ₹.
 *   2. With no font file present, `money()` prints `INR 8,11,792.80`. Correct,
 *      legible, and it never renders a box.
 *
 * The fallback is the default because a repository should not carry a megabyte
 * of binary font to print one glyph, and a document that says INR is not wrong.
 */

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');

export const FONT_FAMILY = 'Helvetica';
export const UNICODE_FONT_FAMILY = 'NotoSans';

let unicodeFontReady: boolean | null = null;

/**
 * Register a rupee-capable font if one has been dropped in. Memoised: called per
 * render, and `Font.register` is not free.
 */
export function ensureFonts(): boolean {
  if (unicodeFontReady !== null) return unicodeFontReady;

  const regular = join(FONT_DIR, 'NotoSans-Regular.ttf');
  const bold = join(FONT_DIR, 'NotoSans-Bold.ttf');

  if (!existsSync(regular)) {
    logger.debug(
      { fontDir: FONT_DIR },
      'No Unicode PDF font found; amounts will print as "INR" rather than the rupee sign',
    );
    unicodeFontReady = false;
    return false;
  }

  try {
    Font.register({
      family: UNICODE_FONT_FAMILY,
      fonts: existsSync(bold)
        ? [
            { src: regular, fontWeight: 'normal' },
            { src: bold, fontWeight: 'bold' },
          ]
        : [{ src: regular, fontWeight: 'normal' }],
    });
    unicodeFontReady = true;
  } catch (err) {
    // A broken font file must not stop a purchase order being printed.
    logger.warn({ err }, 'Unicode PDF font failed to register; falling back to INR');
    unicodeFontReady = false;
  }

  return unicodeFontReady;
}

/** Reset the memo. Tests use it; nothing else should. */
export function resetFontCache(): void {
  unicodeFontReady = null;
}

export const activeFontFamily = (): string =>
  ensureFonts() ? UNICODE_FONT_FAMILY : FONT_FAMILY;

/**
 * Money, Indian-grouped, with a currency marker the active font can actually
 * draw. `8,11,792.80` — never `811,792.80` (10 §8).
 */
export function money(value: string | number): string {
  const formatted = formatIndianNumber(value, 2);
  return ensureFonts() ? `₹${formatted}` : `INR ${formatted}`;
}

/** Quantities carry 3 decimals on a tax document. */
export const qty = (value: string | number): string => formatIndianNumber(value, 3);

export const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 44,
    paddingHorizontal: 28,
    fontSize: 8.5,
    lineHeight: 1.35,
  },
  title: { fontSize: 15, textAlign: 'center', fontWeight: 'bold', letterSpacing: 1.2 },
  subtitle: { fontSize: 8, textAlign: 'center', marginTop: 2, color: '#444444' },

  row: { flexDirection: 'row' },
  spread: { flexDirection: 'row', justifyContent: 'space-between' },

  partyBlock: { flex: 1, borderWidth: 0.75, borderColor: '#333333', padding: 6 },
  partyGap: { width: 8 },
  blockHeading: { fontSize: 8, fontWeight: 'bold', marginBottom: 2, color: '#111111' },
  label: { color: '#555555' },
  bold: { fontWeight: 'bold' },

  metaBox: { borderWidth: 0.75, borderColor: '#333333', padding: 6, marginTop: 8 },

  table: { borderWidth: 0.75, borderColor: '#333333', marginTop: 8 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#ededed', borderBottomWidth: 0.75, borderBottomColor: '#333333' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 0.4, borderBottomColor: '#999999' },
  cell: { padding: 3 },
  cellRight: { padding: 3, textAlign: 'right' },

  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  totalsBox: { width: 250, borderWidth: 0.75, borderColor: '#333333' },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6, paddingVertical: 2 },
  totalsGrand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderTopWidth: 0.75,
    borderTopColor: '#333333',
    backgroundColor: '#ededed',
  },

  words: { marginTop: 8, borderWidth: 0.75, borderColor: '#333333', padding: 6 },
  terms: { marginTop: 8 },
  signatory: { marginTop: 28, alignItems: 'flex-end' },
  signatoryLine: { borderTopWidth: 0.75, borderTopColor: '#333333', width: 160, paddingTop: 3, textAlign: 'center' },

  footer: {
    position: 'absolute',
    bottom: 18,
    left: 28,
    right: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: '#666666',
  },
});

/** Render a document element to a PDF buffer, fonts registered first. */
export async function renderPdf(element: ReactElement<DocumentProps>): Promise<Buffer> {
  ensureFonts();
  return renderToBuffer(element);
}
