import type { LangCode, TranscriptSegment } from '../../shared/types';

const CJK_RE = /[\u3040-\u9FFF]/;
const VI_RE  = /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i;

export function detectLang(text: string, fallback: LangCode = 'ja'): LangCode {
  const t = text.trim();
  if (!t) return fallback;
  let cjk = 0;
  for (const ch of t) { if (CJK_RE.test(ch)) cjk++; }
  if (cjk / t.length > 0.1) return 'ja';
  const vi = (t.match(new RegExp(VI_RE.source, 'gi')) ?? []).length;
  if (vi > 2 || vi / t.length > 0.04) return 'vi';
  return 'en';
}

class LangDetectService {
  detectAll(segments: TranscriptSegment[]): TranscriptSegment[] {
    return segments.map(seg => ({
      ...seg,
      detectedLang: seg.lang !== 'multi' ? seg.lang : detectLang(seg.text, 'ja'),
    }));
  }
}

export const langDetectService = new LangDetectService();
