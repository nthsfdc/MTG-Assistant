import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { UILang } from '../i18n/locales';

type Service = 'deepgram' | 'openai' | 'deepl';

function ApiKeyRow({ svc }: { svc: { key: Service; label: string; hint: string } }) {
  const { t } = useT();
  const [exists, setExists] = useState(false);
  const [value,  setValue]  = useState('');
  const [saving, setSaving] = useState(false);
  const [flash,  setFlash]  = useState<'ok'|'err'|null>(null);

  useEffect(() => { window.api.apikey.exists(svc.key).then(setExists); }, [svc.key]);

  async function save() {
    const v = value.trim(); if (!v || saving) return;
    setSaving(true);
    try { await window.api.apikey.set(svc.key, v); setExists(true); setValue(''); setFlash('ok'); }
    catch { setFlash('err'); } finally { setSaving(false); setTimeout(() => setFlash(null), 2000); }
  }

  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-text-dim">{svc.label}</span>
          <span className="text-xs text-text-muted">{svc.hint}</span>
          {exists && <span className="text-xs text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded ml-auto">{t.settings.configured}</span>}
        </div>
        <input type="password" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()}
          placeholder={exists ? t.settings.enterNewKey : t.settings.pasteKey}
          className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono"
        />
      </div>
      <button onClick={save} disabled={!value.trim() || saving}
        className={`mt-7 px-3.5 py-2 text-sm rounded-lg transition-colors disabled:opacity-40 ${flash==='ok'?'bg-emerald-500 text-white':flash==='err'?'bg-red-500 text-white':'bg-accent hover:bg-accent-hover text-white'}`}>
        {flash==='ok'?'✓':flash==='err'?'✕':saving?'…':t.settings.save}
      </button>
    </div>
  );
}

export function Settings() {
  const { t, uiLang, setUiLang } = useT();
  const [transcriptionLang, setTranscriptionLang] = useState('');
  const [saving,            setSaving]            = useState(false);
  const [saved,             setSaved]             = useState(false);

  const SERVICES: { key: Service; label: string; hint: string }[] = [
    { key: 'deepgram', label: 'Deepgram', hint: t.settings.deepgramHint },
    { key: 'openai',   label: 'OpenAI',   hint: 'Whisper + GPT-4o' },
    { key: 'deepl',    label: 'DeepL',    hint: t.settings.deeplHint },
  ];

  useEffect(() => {
    window.api.settings.get().then(s => setTranscriptionLang(s.transcriptionLanguage));
  }, []);

  async function savePrefs() {
    if (saving) return; setSaving(true);
    await window.api.settings.save({ transcriptionLanguage: transcriptionLang });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  const sel = (label: string, value: string, onChange: (v: string) => void, children: React.ReactNode) => (
    <div>
      <label className="block text-xs text-text-dim mb-1.5">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent">
        {children}
      </select>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border flex-shrink-0">
        <h1 className="text-base font-semibold text-text-primary">{t.settings.title}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg space-y-10">
          <section>
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">{t.settings.apiKeys}</h2>
            <div className="space-y-5">{SERVICES.map(s => <ApiKeyRow key={s.key} svc={s} />)}</div>
            <p className="text-xs text-text-muted mt-3">{t.settings.apiKeysHint}</p>
          </section>
          <section>
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">{t.settings.language}</h2>
            <div className="grid grid-cols-2 gap-3">
              {sel(t.settings.uiLanguage, uiLang, v => setUiLang(v as UILang), <>
                <option value="ja">🇯🇵 日本語</option>
                <option value="en">🇺🇸 English</option>
                <option value="vi">🇻🇳 Tiếng Việt</option>
              </>)}
              {sel(t.settings.whisperHint, transcriptionLang, setTranscriptionLang, <>
                <option value="">{t.settings.whisperAuto}</option>
                <option value="ja">日本語</option>
                <option value="en">English</option>
                <option value="vi">Tiếng Việt</option>
              </>)}
            </div>
          </section>
          <button onClick={savePrefs} disabled={saving}
            className={`w-full py-2.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${saved?'bg-emerald-500 text-white':'bg-accent hover:bg-accent-hover text-white'}`}>
            {saved ? t.settings.saved : saving ? t.settings.saving : t.settings.saveSettings}
          </button>
        </div>
      </div>
    </div>
  );
}
