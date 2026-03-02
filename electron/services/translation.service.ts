import https from 'https';
import { BrowserWindow } from 'electron';
import { secretStore } from '../store/secret.store';
import type { LangCode, TranslationEvent } from '../../shared/types';

const cache = new Map<string, string>();
const MAX_CACHE = 300;

const DEEPL_LANG: Record<string, string> = {
  ja: 'JA', en: 'EN', vi: 'VI', zh: 'ZH', ko: 'KO',
};

const LANG_NAME: Record<string, string> = {
  ja: 'Japanese', en: 'English', vi: 'Vietnamese', multi: 'English',
};

function cacheKey(text: string, targetLang: string) {
  return `${targetLang}:${text.slice(0, 100)}`;
}

class TranslationService {
  /**
   * Async translate — returns translated text.
   * Router: DeepL (if key) → GPT-4o-mini fallback.
   */
  async translateAsync(text: string, sourceLang: LangCode, targetLang: LangCode): Promise<string> {
    const key = cacheKey(text, targetLang);
    const cached = cache.get(key);
    if (cached) return cached;

    const [deeplKey, openaiKey] = await Promise.all([
      secretStore.get('deepl'),
      secretStore.get('openai'),
    ]);

    let result: string;
    if (deeplKey) {
      result = await this._deepl(text, sourceLang, targetLang, deeplKey);
    } else if (openaiKey) {
      result = await this._gpt(text, targetLang, openaiKey);
    } else {
      throw new Error('No translation key (DeepL or OpenAI required)');
    }

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  }

  /**
   * Fire-and-forget translate — sends 'translation' IPC event to renderer.
   * Used by realtime session pipeline.
   */
  translate(
    text: string, sourceLang: LangCode, targetLang: LangCode,
    sessionId: string, speakerId: string, win: BrowserWindow,
    onResult?: (t: string) => void,
  ): void {
    this.translateAsync(text, sourceLang, targetLang).then(translatedText => {
      if (!win.isDestroyed()) {
        win.webContents.send('translation', {
          sessionId, speakerId, sourceText: text, translatedText,
        } satisfies TranslationEvent);
      }
      onResult?.(translatedText);
    }).catch(() => { /* non-blocking */ });
  }

  private _deepl(text: string, sourceLang: LangCode, targetLang: LangCode, apiKey: string): Promise<string> {
    const src = DEEPL_LANG[sourceLang === 'multi' ? 'ja' : sourceLang] ?? 'JA';
    const tgt = DEEPL_LANG[targetLang] ?? 'EN';
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({ text, target_lang: tgt, source_lang: src }).toString();
      const req = https.request({
        hostname: 'api-free.deepl.com', path: '/v2/translate', method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let buf = '';
        res.on('data', (c: string) => (buf += c));
        res.on('end', () => {
          try { resolve((JSON.parse(buf) as { translations: [{ text: string }] }).translations[0].text); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  private async _gpt(text: string, targetLang: LangCode, apiKey: string): Promise<string> {
    const langName = LANG_NAME[targetLang] ?? 'English';
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `Translate to ${langName}. Output ONLY the translation.` },
        { role: 'user', content: text },
      ],
      max_tokens: 512, temperature: 0,
    });
    return r.choices[0]?.message.content?.trim() ?? '';
  }
}

export const translationService = new TranslationService();
