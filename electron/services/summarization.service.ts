import { secretStore } from '../store/secret.store';
import type { NormalizedSegment, MeetingMinutes, MinutesData, LangCode } from '../../shared/types';

const FALLBACK: Record<LangCode, string> = {
  ja: '（自動生成に失敗しました。文字起こしを確認してください。）',
  vi: '(Tạo tự động thất bại. Vui lòng kiểm tra bản ghi âm.)',
  en: '(Automatic generation failed. Please review the transcript.)',
  multi: '(Automatic generation failed. Please review the transcript.)',
};

function fallbackData(lang: LangCode): MinutesData {
  return { purpose: FALLBACK[lang] ?? FALLBACK.en, decisions: [], todos: [], concerns: [], next_actions: [] };
}

class SummarizationService {
  async summarize(segments: NormalizedSegment[], sessionId: string, lang: LangCode, model = 'gpt-4o'): Promise<MeetingMinutes> {
    const apiKey = await secretStore.get('openai');
    if (!apiKey || !segments.length) return { sessionId, generatedAt: Date.now(), language: lang, data: fallbackData(lang) };

    const transcript = segments.map(s => `[${s.speakerId}] ${s.normalizedText}`).join('\n');
    const langMap = { ja: 'Japanese', vi: 'Vietnamese', en: 'English', multi: 'English' };

    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model, temperature: 0, max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `You are an expert meeting analyst. Respond in ${langMap[lang]}. Extract structured meeting minutes as JSON with keys: purpose (string), decisions (string[]), todos (array of {task,assignee,deadline,priority}), concerns (string[]), next_actions (string[]).` },
          { role: 'user', content: `Transcript:\n\n${transcript}` },
        ],
      });
      const raw = JSON.parse(resp.choices[0]?.message.content ?? '{}') as MinutesData;
      const data: MinutesData = {
        purpose: raw.purpose || fallbackData(lang).purpose,
        decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
        todos: Array.isArray(raw.todos) ? raw.todos : [],
        concerns: Array.isArray(raw.concerns) ? raw.concerns : [],
        next_actions: Array.isArray(raw.next_actions) ? raw.next_actions : [],
      };
      return { sessionId, generatedAt: Date.now(), language: lang, data };
    } catch (err) {
      console.error('[Summarization]', err);
      return { sessionId, generatedAt: Date.now(), language: lang, data: fallbackData(lang) };
    }
  }
}

export const summarizationService = new SummarizationService();
