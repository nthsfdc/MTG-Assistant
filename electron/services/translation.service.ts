import https from 'https';
import { BrowserWindow } from 'electron';
import { secretStore } from '../store/secret.store';
import type { TranslationEvent } from '../../shared/types';

const cache = new Map<string, string>();
const MAX = 200;

class TranslationService {
  translate(text: string, sessionId: string, speakerId: string, win: BrowserWindow): void {
    const key = text.slice(0, 120);
    const cached = cache.get(key);
    if (cached) {
      win.webContents.send('translation', { sessionId, speakerId, sourceText: text, translatedText: cached } satisfies TranslationEvent);
      return;
    }
    this._doTranslate(text).then(t => {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, t);
      win.webContents.send('translation', { sessionId, speakerId, sourceText: text, translatedText: t } satisfies TranslationEvent);
    }).catch(() => { /* non-blocking */ });
  }

  private async _doTranslate(text: string): Promise<string> {
    const deeplKey = await secretStore.get('deepl');
    if (deeplKey) return this._deepl(text, deeplKey);
    const openaiKey = await secretStore.get('openai');
    if (openaiKey) return this._gpt(text, openaiKey);
    throw new Error('No translation key');
  }

  private _deepl(text: string, apiKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({ text, target_lang: 'EN', source_lang: 'JA' }).toString();
      const req = https.request({
        hostname: 'api-free.deepl.com', path: '/v2/translate', method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
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

  private async _gpt(text: string, apiKey: string): Promise<string> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Translate to English. Output ONLY the translation.' }, { role: 'user', content: text }],
      max_tokens: 512, temperature: 0,
    });
    return r.choices[0]?.message.content?.trim() ?? '';
  }
}

export const translationService = new TranslationService();
