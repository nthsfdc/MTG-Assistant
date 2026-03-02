export type UILang = 'ja' | 'en' | 'vi';

export interface Locale {
  dateLocale: string;
  nav: { dashboard: string; settings: string };
  dashboard: {
    title: string; loading: string;
    sessions: (n: number) => string;
    newMeeting: string; emptyTitle: string; emptyHint: string; deleteConfirm: string;
  };
  setup: {
    title: string; titleLabel: string; inputLang: string; targetLang: string;
    noTranslation: string;
    cancel: string; start: string; starting: string; failedToStart: string; langMulti: string;
  };
  live: { micAndSystem: string; micOnly: string; stopping: string; stop: string; waitingAudio: string };
  post: {
    loading: string; processing: string; error: string;
    tabs: { overview: string; transcript: string; minutes: string; todos: string };
    steps: { batch_stt: string; lang_detect: string; normalizing: string; summarizing: string; exporting: string };
    duration: (m: number) => string;
    purpose: string; decisions: string; concerns: string; nextActions: string;
    generating: string; noData: string; noTranscript: string; noTodos: string;
    priority: { high: string; medium: string; low: string };
    todoCol: { task: string; assignee: string; deadline: string };
  };
  status: { recording: string; processing: string; done: string; error: string };
  card: { delete: string; duration: (m: number, s: number) => string };
  settings: {
    title: string; apiKeys: string; apiKeysHint: string; configured: string;
    enterNewKey: string; pasteKey: string; save: string;
    language: string; uiLanguage: string;
    whisperHint: string; whisperAuto: string;
    device: string; mic: string; micN: (i: number) => string; systemDefault: string;
    saveSettings: string; saving: string; saved: string;
    deepgramHint: string; deeplHint: string; langMulti: string;
  };
}

const ja: Locale = {
  dateLocale: 'ja-JP',
  nav: { dashboard: 'ダッシュボード', settings: '設定' },
  dashboard: {
    title: 'ミーティング', loading: '読み込み中…',
    sessions: n => `${n} セッション`,
    newMeeting: '＋ 新しいミーティング',
    emptyTitle: 'まだミーティングがありません',
    emptyHint: '新しいミーティングを開始してください',
    deleteConfirm: 'このセッションを削除しますか？',
  },
  setup: {
    title: '新しいミーティング', titleLabel: 'タイトル',
    inputLang: '音声言語', targetLang: '翻訳先',
    noTranslation: '翻訳なし',
    cancel: 'キャンセル', start: '🎙 録音開始', starting: '起動中…',
    failedToStart: '起動に失敗しました', langMulti: '🌐 多言語',
  },
  live: {
    micAndSystem: 'マイク + システム音声', micOnly: 'マイクのみ',
    stopping: '停止中…', stop: '■ 録音停止', waitingAudio: '音声を待っています…',
  },
  post: {
    loading: '読み込み中…', processing: '処理中…', error: 'エラー: ',
    tabs: { overview: '要約', transcript: '文字起こし', minutes: '議事録', todos: 'Todoリスト' },
    steps: { batch_stt: '音声を再認識中…', lang_detect: '言語を検出中…', normalizing: 'テキストを正規化中…', summarizing: 'AIが議事録を生成中…', exporting: 'エクスポート中…' },
    duration: m => `${m}分`,
    purpose: '目的', decisions: '決定事項', concerns: '懸念事項', nextActions: 'ネクストアクション',
    generating: 'AIが議事録を生成中です…', noData: 'データがありません',
    noTranscript: '文字起こしはありません', noTodos: 'Todoはありません',
    priority: { high: '高', medium: '中', low: '低' },
    todoCol: { task: 'タスク', assignee: '担当者', deadline: '期限' },
  },
  status: { recording: '録音中', processing: '処理中', done: '完了', error: 'エラー' },
  card: {
    delete: '削除',
    duration: (m, s) => m > 0 ? `${m}分${s}秒` : `${s}秒`,
  },
  settings: {
    title: '設定', apiKeys: 'API キー',
    apiKeysHint: 'キーはローカルファイルに保存されます。アプリ外には送信されません。',
    configured: '設定済み', enterNewKey: '新しいキーを入力して更新…', pasteKey: 'APIキーを貼り付け…',
    save: '保存', language: '言語', uiLanguage: 'UI言語',
    whisperHint: 'Whisper 言語ヒント', whisperAuto: '自動検出',
    device: 'デバイス', mic: 'マイク', micN: i => `マイク ${i}`, systemDefault: 'システムデフォルト',
    saveSettings: '設定を保存', saving: '保存中…', saved: '✓ 保存しました',
    deepgramHint: 'リアルタイムSTT', deeplHint: '翻訳', langMulti: '🌐 多言語',
  },
};

const en: Locale = {
  dateLocale: 'en-US',
  nav: { dashboard: 'Dashboard', settings: 'Settings' },
  dashboard: {
    title: 'Meetings', loading: 'Loading…',
    sessions: n => `${n} Session${n !== 1 ? 's' : ''}`,
    newMeeting: '+ New Meeting',
    emptyTitle: 'No meetings yet',
    emptyHint: 'Start a new meeting to get started',
    deleteConfirm: 'Delete this session?',
  },
  setup: {
    title: 'New Meeting', titleLabel: 'Title',
    inputLang: 'Speech Language', targetLang: 'Translate To',
    noTranslation: 'No Translation',
    cancel: 'Cancel', start: '🎙 Start Recording', starting: 'Starting…',
    failedToStart: 'Failed to start', langMulti: '🌐 Multilingual',
  },
  live: {
    micAndSystem: 'Mic + System Audio', micOnly: 'Mic Only',
    stopping: 'Stopping…', stop: '■ Stop Recording', waitingAudio: 'Waiting for audio…',
  },
  post: {
    loading: 'Loading…', processing: 'Processing…', error: 'Error: ',
    tabs: { overview: 'Summary', transcript: 'Transcript', minutes: 'Minutes', todos: 'Todo List' },
    steps: { batch_stt: 'Re-recognizing audio…', lang_detect: 'Detecting languages…', normalizing: 'Normalizing text…', summarizing: 'AI generating minutes…', exporting: 'Exporting…' },
    duration: m => `${m}m`,
    purpose: 'Purpose', decisions: 'Decisions', concerns: 'Concerns', nextActions: 'Next Actions',
    generating: 'AI is generating minutes…', noData: 'No data available',
    noTranscript: 'No transcript', noTodos: 'No todos',
    priority: { high: 'High', medium: 'Medium', low: 'Low' },
    todoCol: { task: 'Task', assignee: 'Assignee', deadline: 'Deadline' },
  },
  status: { recording: 'Recording', processing: 'Processing', done: 'Done', error: 'Error' },
  card: {
    delete: 'Delete',
    duration: (m, s) => m > 0 ? `${m}m ${s}s` : `${s}s`,
  },
  settings: {
    title: 'Settings', apiKeys: 'API Keys',
    apiKeysHint: 'Keys are stored locally. Never sent outside the app.',
    configured: 'Configured', enterNewKey: 'Enter new key to update…', pasteKey: 'Paste API key…',
    save: 'Save', language: 'Language', uiLanguage: 'UI Language',
    whisperHint: 'Whisper Language Hint', whisperAuto: 'Auto-detect',
    device: 'Device', mic: 'Microphone', micN: i => `Mic ${i}`, systemDefault: 'System Default',
    saveSettings: 'Save Settings', saving: 'Saving…', saved: '✓ Saved',
    deepgramHint: 'Real-time STT', deeplHint: 'Translation', langMulti: '🌐 Multilingual',
  },
};

const vi: Locale = {
  dateLocale: 'vi-VN',
  nav: { dashboard: 'Tổng quan', settings: 'Cài đặt' },
  dashboard: {
    title: 'Cuộc họp', loading: 'Đang tải…',
    sessions: n => `${n} phiên`,
    newMeeting: '+ Cuộc họp mới',
    emptyTitle: 'Chưa có cuộc họp nào',
    emptyHint: 'Bắt đầu cuộc họp mới để ghi âm',
    deleteConfirm: 'Xóa phiên này?',
  },
  setup: {
    title: 'Cuộc họp mới', titleLabel: 'Tiêu đề',
    inputLang: 'Ngôn ngữ giọng nói', targetLang: 'Dịch sang',
    noTranslation: 'Không dịch',
    cancel: 'Hủy', start: '🎙 Bắt đầu ghi', starting: 'Đang khởi động…',
    failedToStart: 'Khởi động thất bại', langMulti: '🌐 Đa ngôn ngữ',
  },
  live: {
    micAndSystem: 'Mic + Âm thanh hệ thống', micOnly: 'Chỉ mic',
    stopping: 'Đang dừng…', stop: '■ Dừng ghi', waitingAudio: 'Đang chờ âm thanh…',
  },
  post: {
    loading: 'Đang tải…', processing: 'Đang xử lý…', error: 'Lỗi: ',
    tabs: { overview: 'Tóm tắt', transcript: 'Bản ghi', minutes: 'Biên bản', todos: 'Todo List' },
    steps: { batch_stt: 'Đang nhận dạng âm thanh…', lang_detect: 'Đang phát hiện ngôn ngữ…', normalizing: 'Đang chuẩn hóa văn bản…', summarizing: 'AI đang tạo biên bản…', exporting: 'Đang xuất…' },
    duration: m => `${m} phút`,
    purpose: 'Mục đích', decisions: 'Quyết định', concerns: 'Mối lo ngại', nextActions: 'Hành động tiếp theo',
    generating: 'AI đang tạo biên bản họp…', noData: 'Không có dữ liệu',
    noTranscript: 'Không có bản ghi', noTodos: 'Không có việc cần làm',
    priority: { high: 'Cao', medium: 'Trung bình', low: 'Thấp' },
    todoCol: { task: 'Nhiệm vụ', assignee: 'Người thực hiện', deadline: 'Hạn chót' },
  },
  status: { recording: 'Đang ghi', processing: 'Đang xử lý', done: 'Hoàn thành', error: 'Lỗi' },
  card: {
    delete: 'Xóa',
    duration: (m, s) => m > 0 ? `${m}p ${s}s` : `${s}s`,
  },
  settings: {
    title: 'Cài đặt', apiKeys: 'API Keys',
    apiKeysHint: 'Khóa được lưu cục bộ. Không gửi ra ngoài ứng dụng.',
    configured: 'Đã cấu hình', enterNewKey: 'Nhập khóa mới để cập nhật…', pasteKey: 'Dán API key…',
    save: 'Lưu', language: 'Ngôn ngữ', uiLanguage: 'Ngôn ngữ giao diện',
    whisperHint: 'Gợi ý ngôn ngữ Whisper', whisperAuto: 'Tự động phát hiện',
    device: 'Thiết bị', mic: 'Microphone', micN: i => `Mic ${i}`, systemDefault: 'Mặc định hệ thống',
    saveSettings: 'Lưu cài đặt', saving: 'Đang lưu…', saved: '✓ Đã lưu',
    deepgramHint: 'STT thời gian thực', deeplHint: 'Dịch thuật', langMulti: '🌐 Đa ngôn ngữ',
  },
};

export const locales: Record<UILang, Locale> = { ja, en, vi };
