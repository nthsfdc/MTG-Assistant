import type { LangCode, TranscriptSegment } from '../../shared/types';

// Hiragana + Katakana + CJK Unified Ideographs
const CJK_RE = /[\u3040-\u9FFF]/;

// Vietnamese-specific diacritics (not found in other Latin scripts)
const VI_RE = /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i;

/** Detect language from text using Unicode heuristics. */
export function detectLang(text: string, fallback: LangCode = 'ja'): LangCode {
  const trimmed = text.trim();
  if (!trimmed) return fallback;

  let cjkCount = 0;
  for (const ch of trimmed) {
    if (CJK_RE.test(ch)) cjkCount++;
  }
  if (cjkCount / trimmed.length > 0.1) return 'ja';

  const viMatches = trimmed.match(new RegExp(VI_RE.source, 'gi'));
  const viCount = viMatches?.length ?? 0;
  if (viCount > 2 || viCount / trimmed.length > 0.04) return 'vi';

  return 'en';
}

class LangDetectService {
  /**
   * Annotate each segment with `detectedLang`.
   * - If `segment.lang` is a concrete single language (not 'multi'/'none') → inherit it.
   * - Otherwise → run heuristic detection on the segment text.
   */
  detectAll(segments: TranscriptSegment[]): TranscriptSegment[] {
    return segments.map(seg => {
      const detectedLang: LangCode =
        seg.lang !== 'multi' && seg.lang !== 'none'
          ? seg.lang
          : detectLang(seg.text, 'ja');
      return { ...seg, detectedLang };
    });
  }
}

export const langDetectService = new LangDetectService();
