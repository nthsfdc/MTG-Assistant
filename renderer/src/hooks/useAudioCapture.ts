import { useRef } from 'react';

const SAMPLE_RATE = 16_000;
const CHUNK_MS    = 100;

export function useAudioCapture() {
  const ctxRef    = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef   = useRef<AudioWorkletNode | null>(null);

  async function start(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId }, sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                      : { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    ctxRef.current = ctx;

    const workletCode = `
      class ChunkProcessor extends AudioWorkletProcessor {
        constructor() { super(); this._buf = []; this._target = ${Math.round(SAMPLE_RATE * CHUNK_MS / 1000)}; }
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (!ch) return true;
          for (const s of ch) this._buf.push(s);
          while (this._buf.length >= this._target) {
            const chunk = this._buf.splice(0, this._target);
            const pcm = new Int16Array(chunk.map(s => Math.max(-32768, Math.min(32767, s * 32767))));
            this.port.postMessage(pcm.buffer, [pcm.buffer]);
          }
          return true;
        }
      }
      registerProcessor('chunk-processor', ChunkProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const src  = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'chunk-processor');
    nodeRef.current = node;

    let seq = 0;
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      window.api.audio.chunk(seq++, e.data);
    };
    src.connect(node);
  }

  function stop(): void {
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  return { start, stop };
}
