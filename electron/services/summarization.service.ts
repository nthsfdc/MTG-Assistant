import { secretStore } from '../store/secret.store';
import { retry } from '../utils/retry';
import { logger } from '../utils/logger';
import type { NormalizedSegment, MeetingMinutes, MinutesData, DecisionItem, LangCode } from '../../shared/types';

/** Rough token estimate: 1 token ≈ 4 characters. */
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

const LANG_NAME: Record<string, string> = { ja: 'Japanese', vi: 'Vietnamese', en: 'English', multi: 'English' };

const FALLBACK: Record<string, string> = {
  ja: '（自動生成に失敗しました。文字起こしを確認してください。）',
  vi: '(Tạo tự động thất bại. Vui lòng kiểm tra bản ghi âm.)',
  en: '(Automatic generation failed. Please review the transcript.)',
  multi: '(Automatic generation failed. Please review the transcript.)',
};

function fallbackData(lang: LangCode): MinutesData {
  return { purpose: FALLBACK[lang] ?? FALLBACK.en, decisions: [], todos: [], concerns: [], next_actions: [] };
}

const SYSTEM_PROMPT = (lang: string) =>
  `You are an expert meeting analyst. Respond in ${lang}. Extract structured meeting minutes as JSON with keys: purpose (string), decisions (string[]), todos (array of {task,assignee,deadline,priority}), concerns (string[]), next_actions (string[]).`;

class SummarizationService {
  async summarize(
    segments: NormalizedSegment[], sessionId: string, lang: LangCode, model = 'gpt-4o',
  ): Promise<MeetingMinutes> {
    const apiKey = await secretStore.get('openai');
    if (!apiKey || !segments.length) {
      return { sessionId, generatedAt: Date.now(), language: lang, data: fallbackData(lang) };
    }

    const OpenAI   = (await import('openai')).default;
    const client   = new OpenAI({ apiKey });
    const langName = LANG_NAME[lang] ?? 'English';
    const transcript = segments.map(s => `[${s.speakerId}] ${s.normalizedText}`).join('\n');
    const tokens     = estimateTokens(transcript);

    try {
      let data: MinutesData;
      if (tokens <= 12_000) {
        data = await this._directSummarize(client, transcript, langName, model);
      } else {
        logger.info('[Summarization] using hierarchical pipeline', { sessionId, tokens });
        data = await this._hierarchicalSummarize(client, transcript, langName, model);
      }
      return { sessionId, generatedAt: Date.now(), language: lang, data };
    } catch (err) {
      logger.error('[Summarization] failed', { sessionId, error: (err as Error).message });
      return { sessionId, generatedAt: Date.now(), language: lang, data: fallbackData(lang) };
    }
  }

  private async _directSummarize(
    client: InstanceType<Awaited<typeof import('openai')>['default']>,
    transcript: string, langName: string, model: string,
  ): Promise<MinutesData> {
    const resp = await retry(() => client.chat.completions.create({
      model, temperature: 0, max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(langName) },
        { role: 'user',   content: `Transcript:\n\n${transcript}` },
      ],
    }));
    return this._parseMinutes(resp.choices[0]?.message.content ?? '{}', langName);
  }

  private async _hierarchicalSummarize(
    client: InstanceType<Awaited<typeof import('openai')>['default']>,
    transcript: string, langName: string, model: string,
  ): Promise<MinutesData> {
    // Pass 1: chunk by ~32k chars and get prose summaries via gpt-4o-mini
    const BLOCK_CHARS = 32_000;
    const blocks: string[] = [];
    for (let i = 0; i < transcript.length; i += BLOCK_CHARS) {
      blocks.push(transcript.slice(i, i + BLOCK_CHARS));
    }

    const proseSummaries: string[] = [];
    for (const block of blocks) {
      const r = await retry(() => client.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, max_tokens: 2048,
        messages: [
          { role: 'system', content: `Summarize this meeting transcript segment in ${langName} as detailed prose, preserving all decisions, todos, concerns, and action items.` },
          { role: 'user',   content: block },
        ],
      }));
      proseSummaries.push(r.choices[0]?.message.content ?? '');
    }

    let combined = proseSummaries.join('\n\n---\n\n');

    // Reduction pass: if combined summary still too long, compress further
    if (estimateTokens(combined) > 12_000) {
      const r = await retry(() => client.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, max_tokens: 8000,
        messages: [
          { role: 'system', content: `Consolidate these meeting summaries into a single detailed prose in ${langName}, keeping all key information.` },
          { role: 'user',   content: combined },
        ],
      }));
      combined = r.choices[0]?.message.content ?? combined;
    }

    // Pass 2: GPT-4o strict JSON extraction from consolidated prose
    const resp = await retry(() => client.chat.completions.create({
      model, temperature: 0, max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(langName) },
        { role: 'user',   content: `Meeting summary:\n\n${combined}` },
      ],
    }));
    return this._parseMinutes(resp.choices[0]?.message.content ?? '{}', langName);
  }

  private _parseMinutes(json: string, _langName: string): MinutesData {
    try {
      const raw = JSON.parse(json) as Record<string, unknown>;
      // decisions: GPT returns string[] — normalize to DecisionItem[] for type safety
      const rawDecisions = Array.isArray(raw.decisions) ? raw.decisions as (string | DecisionItem)[] : [];
      const decisions: DecisionItem[] = rawDecisions.map(d =>
        typeof d === 'string' ? { text: d } : d,
      );
      return {
        purpose:      typeof raw.purpose === 'string' ? raw.purpose : FALLBACK.en,
        decisions,
        todos:        Array.isArray(raw.todos)        ? raw.todos as MinutesData['todos']        : [],
        concerns:     Array.isArray(raw.concerns)     ? raw.concerns as string[]     : [],
        next_actions: Array.isArray(raw.next_actions) ? raw.next_actions as string[] : [],
      };
    } catch { return fallbackData('en'); }
  }
}

export const summarizationService = new SummarizationService();
