export type SessionStatus = 'recording' | 'processing' | 'done' | 'error' | 'error_recoverable';
export type LangCode = 'ja' | 'vi' | 'en' | 'multi';
export type InputType = 'recording' | 'import';
export type PipelineStep = 'prepare_audio' | 'batch_stt' | 'lang_detect' | 'normalizing' | 'summarizing' | 'exporting' | 'done';

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  inputType: InputType;
  startedAt: number;
  endedAt: number | null;
  lang: LangCode;
  durationMs: number | null;
  errorMsg: string | null;
  sourceFileName?: string;
  sourceFilePath?: string; // full path (backend only — not exposed to renderer)
}

export type SessionMeta = Pick<
  Session,
  'id' | 'title' | 'status' | 'inputType' | 'startedAt' | 'endedAt' | 'lang' | 'durationMs' | 'sourceFileName'
>;

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  speakerId: string;
  text: string;
  lang: LangCode;
  detectedLang?: LangCode;
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

export interface PipelineState {
  sessionId: string;
  steps: { name: PipelineStep; status: 'pending' | 'running' | 'done' | 'error'; completedAt?: number }[];
  currentStep: PipelineStep;
  error?: string;
}

export interface SessionDetail extends SessionMeta {
  errorMsg: string | null;
  segments: TranscriptSegment[];
  normalized: NormalizedSegment[] | null;
  minutes: MeetingMinutes | null;
  pipeline: PipelineState | null;
}

export interface AppSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  transcriptionLanguage: string;
  uiLang: 'ja' | 'en' | 'vi';
  storageRootPath: string;
  autoCleanupDays: number;
  archiveSource: boolean;
}

export interface StorageStats {
  sessionCount: number;
  totalBytes: number;
  freeBytes: number;
  storageRoot: string;
}

export interface ImportPayload {
  title: string;
  lang: LangCode;
  filePath: string;
}

export interface MediaProbeResult {
  format: string;
  durationSec: number;
  hasAudio: boolean;
  fileSizeBytes: number;
}

export interface StartSessionPayload {
  title: string;
  lang: LangCode;
}

export interface StartSessionResult {
  sessionId: string;
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

export interface StorageWarningEvent {
  freeBytes: number;
  threshold: 'warn' | 'block';
}
