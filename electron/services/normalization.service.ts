import { secretStore } from '../store/secret.store';
import type { TranscriptSegment, NormalizedSegment, LangCode } from '../../shared/types';

// ── Phase 1: rule-based cleanup ───────────────────────────────────────────────

/** Tokens always removed regardless of position (fillers / hesitations). */
const ALWAYS: Record<string, Set<string>> = {
  ja: new Set(['ええと','えーと','えと','あのー','あの','うーん','うーんと','まあ','ん']),
  vi: new Set(['ừm','ờm','ừ','ơ','ờ']),
  en: new Set(['uh','um','hmm','uh-huh','mm-hmm']),
};

/** Tokens removed only when the segment is a single isolated token. */
const ISOLATED: Record<string, Set<string>> = {
  ja: new Set(['なるほど','そうですね','はい','ええ','うん']),
  vi: new Set(['vâng','rồi','thì','cũng','à']),
  en: new Set(['right','okay','yeah','sure','yep','ok']),
};

const STRIP_PUNCT = /[、。,!？.！]/g;

function ruleClean(text: string, lang: LangCode): string {
  const always   = ALWAYS[lang]   ?? ALWAYS.en;
  const isolated = ISOLATED[lang] ?? ISOLATED.en;

  const tokens = text.split(/\s+/).filter(Boolean)
    .filter(t => !always.has(t.toLowerCase().replace(STRIP_PUNCT, '')));

  if (!tokens.length) return '';
  if (tokens.length === 1 && isolated.has(tokens[0].toLowerCase().replace(STRIP_PUNCT, ''))) return '';
  return tokens.join(' ');
}

// ── Phase 2: LLM rewrite (language-aware) ────────────────────────────────────

const LANG_NAME: Record<string, string> = {
  ja: 'Japanese', vi: 'Vietnamese', en: 'English',
};

class NormalizationService {
  async normalize(segments: TranscriptSegment[]): Promise<NormalizedSegment[]> {
    const results: NormalizedSegment[] = [];

    for (const seg of segments) {
      // detectedLang is set by LangDetect step; fall back just in case
      const lang: LangCode =
        seg.detectedLang ?? (seg.lang !== 'multi' && seg.lang !== 'none' ? seg.lang : 'ja');

      const cleaned = ruleClean(seg.text, lang);
      if (cleaned) {
        results.push({
          sourceId: seg.id, speakerId: seg.speakerId,
          originalText: seg.text, normalizedText: cleaned,
          detectedLang: lang, method: 'rule',
        });
      }
    }

    // LLM pass only on segments long enough to benefit
    const forLlm = results.filter(r => r.normalizedText.length > 30);
    if (forLlm.length > 0) await this._llmPass(forLlm).catch(() => {});

    return results;
  }

  private async _llmPass(segments: NormalizedSegment[]): Promise<void> {
    const apiKey = await secretStore.get('openai');
    if (!apiKey) return;

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });

    // Group by detectedLang → each batch stays in one language
    const byLang = new Map<LangCode, NormalizedSegment[]>();
    for (const s of segments) {
      const arr = byLang.get(s.detectedLang) ?? [];
      arr.push(s);
      byLang.set(s.detectedLang, arr);
    }

    for (const [lang, langSegs] of byLang) {
      const langName = LANG_NAME[lang] ?? 'English';
      const BATCH = 20;
      for (let i = 0; i < langSegs.length; i += BATCH) {
        const batch = langSegs.slice(i, i + BATCH);
        const input = batch.map((s, j) => `${j + 1}. ${s.normalizedText}`).join('\n');
        try {
          const r = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  `Convert spoken ${langName} to natural written ${langName}. ` +
                  `Fix disfluencies and incomplete sentences. Do NOT translate. ` +
                  `Return the same numbered lines, one per line.`,
              },
              { role: 'user', content: input },
            ],
            max_tokens: 1024, temperature: 0,
          });
          (r.choices[0]?.message.content ?? '')
            .split('\n')
            .map(l => l.replace(/^\d+\.\s*/, '').trim())
            .filter(Boolean)
            .forEach((t, j) => {
              if (j < batch.length && t) {
                batch[j].normalizedText = t;
                batch[j].method = 'llm';
              }
            });
        } catch { /* keep rule output */ }
      }
    }
  }
}

export const normalizationService = new NormalizationService();
