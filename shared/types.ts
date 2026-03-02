export type SessionStatus = 'recording' | 'processing' | 'done' | 'error';
export type LangCode = 'ja' | 'vi' | 'en' | 'multi' | 'none';

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
  lang: LangCode;
  targetLang: LangCode;
  durationMs: number | null;
  errorMsg: string | null;
}

export type SessionMeta = Pick<
  Session,
  'id' | 'title' | 'status' | 'startedAt' | 'endedAt' | 'lang' | 'durationMs'
>;

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  speakerId: string;
  text: string;
  lang: LangCode;
  detectedLang?: LangCode; // populated by LangDetect step (post-meeting)
  startMs: number;
  endMs: number;
}

export interface NormalizedSegment {
  sourceId: string;
  speakerId: string;
  originalText: string;
  normalizedText: string;
  detectedLang: LangCode;
  method: 'rule' | 'llm';
}

export interface TodoItem {
  task: string;
  assignee: string | null;
  deadline: string | null;
  priority: 'high' | 'medium' | 'low';
}

export interface MinutesData {
  purpose: string;
  decisions: string[];
  todos: TodoItem[];
  concerns: string[];
  next_actions: string[];
}

export interface MeetingMinutes {
  sessionId: string;
  generatedAt: number;
  language: LangCode;
  data: MinutesData;
}

export interface SessionDetail extends SessionMeta {
  targetLang: LangCode;
  errorMsg: string | null;
  segments: TranscriptSegment[];
  minutes: MeetingMinutes | null;
}

export interface AppSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  transcriptionLanguage: string;
  uiLang: 'ja' | 'en' | 'vi';
}

export interface StartSessionPayload {
  title: string;
  lang: LangCode;
  targetLang: LangCode;
}

export interface StartSessionResult {
  sessionId: string;
}

export interface SttPartialEvent {
  sessionId: string;
  speakerId: string;
  text: string;
}

export interface SttFinalEvent {
  sessionId: string;
  speakerId: string;
  text: string;
  lang: LangCode;
  startMs: number;
  endMs: number;
}

export interface TranslationEvent {
  sessionId: string;
  sourceText: string;
  translatedText: string;
  speakerId: string;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  detail?: string;
}

export interface SessionDoneEvent {
  sessionId: string;
  exportPath: string;
}

export interface ErrorEvent {
  code: string;
  message: string;
  sessionId?: string;
}
