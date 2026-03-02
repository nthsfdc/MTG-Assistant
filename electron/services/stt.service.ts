import { BrowserWindow } from 'electron';
import { secretStore } from '../store/secret.store';
import type { LangCode, SttPartialEvent, SttFinalEvent } from '../../shared/types';

type SpeechFinalCallback = (speakerId: string, text: string) => void;
type SegmentCallback = (event: SttFinalEvent) => void;

type WsInstance = { on: Function; send: Function; close: Function; readyState: number };

// require('ws') returns the WebSocket constructor directly in CJS (not .default)
let WS: (new (url: string, opts: object) => WsInstance) | null = null;
try { WS = require('ws'); } catch { /* ws not installed */ }

export class SttService {
  private ws: WsInstance | null = null;
  private sessionId: string | null = null;
  private lang: LangCode = 'ja';
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onSpeechFinal?: SpeechFinalCallback;
  private onSegment?: SegmentCallback;
  private readonly win: BrowserWindow;

  constructor(win: BrowserWindow) { this.win = win; }

  async start(sessionId: string, lang: LangCode, onSpeechFinal?: SpeechFinalCallback, onSegment?: SegmentCallback): Promise<void> {
    this.sessionId     = sessionId;
    this.lang          = lang;
    this.closed        = false;
    this.onSpeechFinal = onSpeechFinal;
    this.onSegment     = onSegment;
    await this._connect();
  }

  private async _connect(): Promise<void> {
    if (!WS) { console.warn('[SttService] ws not available'); return; }
    const apiKey = await secretStore.get('deepgram');
    if (!apiKey) { console.warn('[SttService] no Deepgram key'); return; }

    const params = new URLSearchParams({
      model: 'nova-3',
      language: this.lang === 'multi' ? 'multi' : this.lang,
      encoding: 'linear16', sample_rate: '16000', channels: '1',
      diarize: 'true', smart_format: 'true', punctuate: 'true',
      interim_results: 'true', utterance_end_ms: '1000',
    });
    const ws = new WS(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    this.ws = ws;

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string; is_final: boolean; speech_final: boolean;
          start: number; duration: number;
          channel: { alternatives: Array<{ transcript: string; words: Array<{ speaker?: number }> }> };
        };
        if (msg.type !== 'Results') return;
        const alt = msg.channel.alternatives[0];
        const text = alt?.transcript?.trim() ?? '';
        if (!text) return;
        const speakerId = `speaker_${alt?.words?.[0]?.speaker ?? 0}`;

        if (!msg.is_final) {
          this.win.webContents.send('stt:partial', { sessionId: this.sessionId!, speakerId, text } satisfies SttPartialEvent);
        } else {
          const evt: SttFinalEvent = {
            sessionId: this.sessionId!, speakerId, text,
            lang: this.lang === 'multi' ? 'ja' : this.lang,
            startMs: Math.round(msg.start * 1000), endMs: Math.round((msg.start + msg.duration) * 1000),
          };
          this.win.webContents.send('stt:final', evt);
          this.onSegment?.(evt);
          if (msg.speech_final) this.onSpeechFinal?.(speakerId, text);
        }
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this._connect().catch(console.error), 2000);
      }
    });
    ws.on('error', (e: Error) => console.error('[SttService]', e.message));
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws?.readyState === 1 /* OPEN */) this.ws.send(Buffer.from(pcm));
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.sessionId = null;
  }
}
