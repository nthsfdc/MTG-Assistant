import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { UILang } from '../i18n/locales';
import type { StorageStats } from '../../../shared/types';

type Service = 'openai';

function ApiKeyRow({ svc }: { svc: { key: Service; label: string; hint: string } }) {
  const { t } = useT();
  const [exists,   setExists]   = useState(false);
  const [masked,   setMasked]   = useState('');
  const [isDirty,  setIsDirty]  = useState(false);
  const [newValue, setNewValue] = useState('');
  const [saving,   setSaving]   = useState(false);
  const [flash,    setFlash]    = useState<'ok'|'err'|null>(null);

  useEffect(() => {
    window.api.apikey.exists(svc.key).then(async ok => {
      setExists(ok);
      if (ok) {
        const m = await window.api.apikey.getMasked(svc.key);
        setMasked(m);
      }
    });
  }, [svc.key]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setIsDirty(true);
    setNewValue(e.target.value);
  }

  function handleFocus() {
    if (!isDirty) setNewValue('');
    setIsDirty(true);
  }

  async function save() {
    const v = newValue.trim(); if (!v || saving) return;
    setSaving(true);
    try {
      await window.api.apikey.set(svc.key, v);
      setExists(true);
      const m = await window.api.apikey.getMasked(svc.key);
      setMasked(m);
      setNewValue(''); setIsDirty(false); setFlash('ok');
    }
    catch { setFlash('err'); }
    finally { setSaving(false); setTimeout(() => setFlash(null), 2000); }
  }

  const displayValue = isDirty ? newValue : exists ? masked : newValue;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-medium text-text-dim">{svc.label}</span>
        <span className="text-xs text-text-muted">{svc.hint}</span>
        {exists && <span className="text-xs text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded ml-auto">{t.settings.configured}</span>}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={displayValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder={exists ? t.settings.enterNewKey : t.settings.pasteKey}
          className="flex-1 px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono"
        />
        <button onClick={save} disabled={!isDirty || !newValue.trim() || saving}
          className={`px-3.5 py-2 text-sm rounded-lg transition-colors disabled:opacity-40 ${flash==='ok'?'bg-emerald-500 text-white':flash==='err'?'bg-red-500 text-white':'bg-accent hover:bg-accent-hover text-white'}`}>
          {flash==='ok'?'✓':flash==='err'?'✕':saving?'…':t.settings.save}
        </button>
      </div>
    </div>
  );
}

function bytesToGB(b: number) { return (b / 1024 / 1024 / 1024).toFixed(2); }
function bytesToMB(b: number) { return (b / 1024 / 1024).toFixed(1); }

export function Settings() {
  const { t, uiLang, setUiLang } = useT();
  const [transcriptionLang, setTranscriptionLang] = useState('');
  const [storageRoot,       setStorageRoot]       = useState('');
  const [autoCleanupDays,   setAutoCleanupDays]   = useState(30);
  const [archiveSource,     setArchiveSource]     = useState(false);
  const [stats,             setStats]             = useState<StorageStats | null>(null);
  const [saving,            setSaving]            = useState(false);
  const [saved,             setSaved]             = useState(false);
  const [cleanupRunning,    setCleanupRunning]    = useState(false);

  useEffect(() => {
    window.api.settings.get().then(s => {
      setTranscriptionLang(s.transcriptionLanguage);
      setStorageRoot(s.storageRootPath ?? '');
      setAutoCleanupDays(s.autoCleanupDays ?? 30);
      setArchiveSource(s.archiveSource ?? false);
    });
    window.api.storage.getStats().then(setStats);
  }, []);

  async function savePrefs() {
    if (saving) return; setSaving(true);
    await window.api.settings.save({
      transcriptionLanguage: transcriptionLang,
      storageRootPath: storageRoot,
      autoCleanupDays,
      archiveSource,
    });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  async function runCleanup() {
    if (cleanupRunning) return;
    setCleanupRunning(true);
    try {
      await window.api.storage.runCleanup();
      const s = await window.api.storage.getStats();
      setStats(s);
    } finally { setCleanupRunning(false); }
  }

  const SERVICES: { key: Service; label: string; hint: string }[] = [
    { key: 'openai', label: 'OpenAI', hint: 'Whisper + GPT-4o' },
  ];

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

          <section>
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">{t.settings.storage}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-text-dim mb-1.5">{t.settings.storageRoot}</label>
                <input type="text" value={storageRoot} onChange={e => setStorageRoot(e.target.value)}
                  placeholder={t.settings.storageRootDefault}
                  className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono" />
                <p className="text-xs text-text-muted mt-1">{t.settings.storageRootHint}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-dim mb-1.5">{t.settings.autoCleanupDays}</label>
                  <input type="number" min={1} max={365} value={autoCleanupDays}
                    onChange={e => setAutoCleanupDays(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent" />
                </div>
                <div className="flex items-end pb-px">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={archiveSource} onChange={e => setArchiveSource(e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-accent" />
                    <span className="text-xs text-text-dim">{t.settings.archiveSource}</span>
                  </label>
                </div>
              </div>
              {stats && (
                <div className="bg-surface-2 border border-border rounded-lg p-3 space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">{t.settings.statsSessions}</span>
                    <span className="text-text-dim">{stats.sessionCount}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">{t.settings.statsUsed}</span>
                    <span className="text-text-dim">{bytesToMB(stats.totalBytes)} MB</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">{t.settings.statsFree}</span>
                    <span className="text-text-dim">{bytesToGB(stats.freeBytes)} GB</span>
                  </div>
                  <button onClick={runCleanup} disabled={cleanupRunning}
                    className="w-full mt-2 py-1.5 text-xs border border-border rounded-lg text-text-muted hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-40">
                    {cleanupRunning ? '…' : t.settings.runCleanup}
                  </button>
                </div>
              )}
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
