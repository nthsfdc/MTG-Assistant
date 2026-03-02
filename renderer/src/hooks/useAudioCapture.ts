import { useCallback, useRef } from 'react';

const WORKLET = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._b=new Float32Array(1600);this._p=0;this._g=1;this._e=0; }
  process(inputs) {
    const ch=inputs[0]?.[0]; if(!ch||!ch.length)return true;
    for(let i=0;i<ch.length;i++){
      this._b[this._p++]=ch[i]*this._g;
      if(this._p>=1600){
        let ss=0; for(let j=0;j<1600;j++)ss+=this._b[j]*this._b[j];
        const r=Math.sqrt(ss/1600);
        this._e=0.05*r+0.95*this._e;
        if(this._e>0.0001)this._g=Math.min(4,0.08/this._e);
        const p=new Int16Array(1600);
        for(let j=0;j<1600;j++){const v=this._b[j]*32767;p[j]=v>32767?32767:v<-32768?-32768:(v|0);}
        this.port.postMessage({pcm:p},[p.buffer]);
        this._p=0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor',PcmProcessor);
`;

export function useAudioCapture() {
  const ctxRef     = useRef<AudioContext | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const seqRef     = useRef(0);

  const start = useCallback(async (inputDeviceId?: string): Promise<{ hasSysAudio: boolean }> => {
    const ctx = new AudioContext({ sampleRate: 16000 });
    ctxRef.current = ctx;
    const blob = new Blob([WORKLET], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const node = new AudioWorkletNode(ctx, 'pcm-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array }>) => {
      window.api.audio.chunk(seqRef.current++, e.data.pcm.buffer as ArrayBuffer);
    };

    const micConstraints: MediaTrackConstraints = {
      channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true,
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
    };
    let micStream: MediaStream;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints }); }
    catch { micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } }); }
    streamsRef.current.push(micStream);
    ctx.createMediaStreamSource(micStream).connect(node);

    let hasSysAudio = false;
    try {
      const sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false } as MediaStreamConstraints);
      streamsRef.current.push(sys);
      ctx.createMediaStreamSource(sys).connect(node);
      hasSysAudio = true;
    } catch { /* mic-only fallback */ }

    return { hasSysAudio };
  }, []);

  const stop = useCallback(() => {
    streamsRef.current.forEach(s => s.getTracks().forEach(t => t.stop()));
    streamsRef.current = [];
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    seqRef.current = 0;
  }, []);

  return { start, stop };
}
