export type UILang = 'ja' | 'en' | 'vi';

export interface Locale {
  dateLocale: string;
  appName: string;
  nav: { dashboard: string; settings: string };
  dashboard: {
    title: string; loading: string;
    sessions: (n: number) => string;
    newMeeting: string; importFile: string; emptyTitle: string; emptyHint: string; deleteConfirm: string;
    diskWarn: string; diskBlock: string; diskFree: string;
    search: string; noResults: string;
  };
  setup: {
    title: string; titleLabel: string; inputLang: string;
    cancel: string; start: string; starting: string; failedToStart: string; langMulti: string;
  };
  recording: { stopping: string; stop: string };
  import: {
    title: string; fileLabel: string; noFileSelected: string; browse: string;
    noPathError: string; noAudioError: string; probeError: string;
    startImport: string; importing: string; failed: string;
  };
  post: {
    loading: string; processing: string; error: string;
    tabs: { overview: string; transcript: string; todos: string };
    steps: {
      prepare_audio: string; batch_stt: string; lang_detect: string;
      normalizing: string; summarizing: string; exporting: string;
    };
    duration: (m: number) => string;
    purpose: string; decisions: string; concerns: string; nextActions: string;
    generating: string; noData: string; noTranscript: string; noTodos: string;
    priority: { high: string; medium: string; low: string };
    todoCol: { task: string; assignee: string; deadline: string };
    retryStep: string; resumePipeline: string;
    todoCopy: string; todoCopied: string; todoExport: string;
    progressStep: (current: number, total: number) => string;
  };
  status: { recording: string; processing: string; done: string; error: string; error_recoverable: string };
  card: { delete: string; duration: (m: number, s: number) => string };
  settings: {
    title: string; apiKeys: string; apiKeysHint: string; configured: string;
    enterNewKey: string; pasteKey: string; save: string;
    language: string; uiLanguage: string;
    whisperHint: string; whisperAuto: string;
    device: string; mic: string; micN: (i: number) => string; systemDefault: string;
    saveSettings: string; saving: string; saved: string;
    storage: string;
    storageRoot: string; storageRootDefault: string; storageRootHint: string;
    autoCleanupDays: string; archiveSource: string;
    statsSessions: string; statsUsed: string; statsFree: string; runCleanup: string;
  };
}

const ja: Locale = {
  dateLocale: 'ja-JP',
  appName: '会議アシスタント',
  nav: { dashboard: '会議履歴', settings: '設定' },
  dashboard: {
    title: 'ミーティング', loading: '読み込み中…',
    sessions: n => `${n} セッション`,
    newMeeting: '＋ 新しいミーティング',
    importFile: '音声インポート',
    emptyTitle: 'まだミーティングがありません',
    emptyHint: '新しいミーティングを開始するか、音声ファイルをインポートしてください',
    deleteConfirm: 'このセッションを削除しますか？',
    diskWarn: 'ディスク容量が少なくなっています',
    diskBlock: 'ディスク容量不足のためインポートできません',
    diskFree: '空き',
    search: 'ミーティングを検索…', noResults: '一致するミーティングがありません',
  },
  setup: {
    title: '新しいミーティング', titleLabel: 'タイトル',
    inputLang: '音声言語',
    cancel: 'キャンセル', start: '🎙 録音開始', starting: '起動中…',
    failedToStart: '起動に失敗しました', langMulti: '🌐 多言語',
  },
  recording: { stopping: '停止中…', stop: '■ 録音停止' },
  import: {
    title: '音声インポート', fileLabel: 'ファイル', noFileSelected: 'ファイルを選択してください',
    browse: '選択', noPathError: 'ファイルパスを取得できませんでした',
    noAudioError: '音声トラックが見つかりません', probeError: 'ファイルを読み取れませんでした',
    startImport: 'インポート開始', importing: '処理中…', failed: 'インポートに失敗しました',
  },
  post: {
    loading: '読み込み中…', processing: '処理中…', error: 'エラー: ',
    tabs: { overview: '要約', transcript: '文字起こし', todos: 'Todo' },
    steps: {
      prepare_audio: '音声を準備中…',
      batch_stt: '音声を再認識中…', lang_detect: '言語を検出中…',
      normalizing: 'テキストを正規化中…', summarizing: 'AIが議事録を生成中…', exporting: 'エクスポート中…',
    },
    duration: m => `${m}分`,
    purpose: '目的', decisions: '決定事項', concerns: '懸念事項', nextActions: 'ネクストアクション',
    generating: 'AIが議事録を生成中です…', noData: 'データがありません',
    noTranscript: '文字起こしはありません', noTodos: 'Todoはありません',
    priority: { high: '高', medium: '中', low: '低' },
    todoCol: { task: 'タスク', assignee: '担当者', deadline: '期限' },
    retryStep: '再試行', resumePipeline: 'パイプラインを再開',
    todoCopy: 'コピー', todoCopied: 'コピーしました！', todoExport: 'Markdownで保存',
    progressStep: (c, total) => `ステップ ${c} / ${total}`,
  },
  status: { recording: '録音中', processing: '処理中', done: '完了', error: 'エラー', error_recoverable: '再試行可能' },
  card: {
    delete: '削除',
    duration: (m, s) => m > 0 ? `${m}分${s}秒` : `${s}秒`,
  },
  settings: {
    title: '設定', apiKeys: 'API キー',
    apiKeysHint: 'キーはOSキーチェーンに保存されます。アプリ外には送信されません。',
    configured: '設定済み', enterNewKey: '新しいキーを入力して更新…', pasteKey: 'APIキーを貼り付け…',
    save: '保存', language: '言語', uiLanguage: 'UI言語',
    whisperHint: 'Whisper 言語ヒント', whisperAuto: '自動検出',
    device: 'デバイス', mic: 'マイク', micN: i => `マイク ${i}`, systemDefault: 'システムデフォルト',
    saveSettings: '設定を保存', saving: '保存中…', saved: '✓ 保存しました',
    storage: 'ストレージ',
    storageRoot: '保存場所', storageRootDefault: '(デフォルト: AppData)', storageRootHint: '空白の場合はデフォルトパスを使用',
    autoCleanupDays: '自動削除 (日後)', archiveSource: 'インポート元ファイルを保存',
    statsSessions: 'セッション数', statsUsed: '使用容量', statsFree: '空き容量', runCleanup: '今すぐクリーンアップ',
  },
};

const en: Locale = {
  dateLocale: 'en-US',
  appName: 'Meeting Assistant',
  nav: { dashboard: 'Meeting History', settings: 'Settings' },
  dashboard: {
    title: 'Meetings', loading: 'Loading…',
    sessions: n => `${n} Session${n !== 1 ? 's' : ''}`,
    newMeeting: '+ New Meeting',
    importFile: 'Import Audio',
    emptyTitle: 'No meetings yet',
    emptyHint: 'Start a new meeting or import an audio file',
    deleteConfirm: 'Delete this session?',
    diskWarn: 'Low disk space',
    diskBlock: 'Not enough disk space to import',
    diskFree: 'free',
    search: 'Search meetings…', noResults: 'No matching meetings',
  },
  setup: {
    title: 'New Meeting', titleLabel: 'Title',
    inputLang: 'Speech Language',
    cancel: 'Cancel', start: '🎙 Start Recording', starting: 'Starting…',
    failedToStart: 'Failed to start', langMulti: '🌐 Multilingual',
  },
  recording: { stopping: 'Stopping…', stop: '■ Stop Recording' },
  import: {
    title: 'Import Audio', fileLabel: 'File', noFileSelected: 'No file selected',
    browse: 'Browse', noPathError: 'Could not get file path',
    noAudioError: 'No audio track found', probeError: 'Could not read file',
    startImport: 'Start Import', importing: 'Processing…', failed: 'Import failed',
  },
  post: {
    loading: 'Loading…', processing: 'Processing…', error: 'Error: ',
    tabs: { overview: 'Summary', transcript: 'Transcript', todos: 'Todo' },
    steps: {
      prepare_audio: 'Preparing audio…',
      batch_stt: 'Re-recognizing audio…', lang_detect: 'Detecting languages…',
      normalizing: 'Normalizing text…', summarizing: 'AI generating minutes…', exporting: 'Exporting…',
    },
    duration: m => `${m}m`,
    purpose: 'Purpose', decisions: 'Decisions', concerns: 'Concerns', nextActions: 'Next Actions',
    generating: 'AI is generating minutes…', noData: 'No data available',
    noTranscript: 'No transcript', noTodos: 'No todos',
    priority: { high: 'High', medium: 'Medium', low: 'Low' },
    todoCol: { task: 'Task', assignee: 'Assignee', deadline: 'Deadline' },
    retryStep: 'Retry', resumePipeline: 'Resume Pipeline',
    todoCopy: 'Copy', todoCopied: 'Copied!', todoExport: 'Save as Markdown',
    progressStep: (c, total) => `Step ${c} / ${total}`,
  },
  status: { recording: 'Recording', processing: 'Processing', done: 'Done', error: 'Error', error_recoverable: 'Retryable' },
  card: {
    delete: 'Delete',
    duration: (m, s) => m > 0 ? `${m}m ${s}s` : `${s}s`,
  },
  settings: {
    title: 'Settings', apiKeys: 'API Keys',
    apiKeysHint: 'Keys are stored in the OS keychain. Never sent outside the app.',
    configured: 'Configured', enterNewKey: 'Enter new key to update…', pasteKey: 'Paste API key…',
    save: 'Save', language: 'Language', uiLanguage: 'UI Language',
    whisperHint: 'Whisper Language Hint', whisperAuto: 'Auto-detect',
    device: 'Device', mic: 'Microphone', micN: i => `Mic ${i}`, systemDefault: 'System Default',
    saveSettings: 'Save Settings', saving: 'Saving…', saved: '✓ Saved',
    storage: 'Storage',
    storageRoot: 'Storage Location', storageRootDefault: '(default: AppData)', storageRootHint: 'Leave blank to use the default path',
    autoCleanupDays: 'Auto-delete after (days)', archiveSource: 'Keep imported source file',
    statsSessions: 'Sessions', statsUsed: 'Used', statsFree: 'Free', runCleanup: 'Run Cleanup Now',
  },
};

const vi: Locale = {
  dateLocale: 'vi-VN',
  appName: 'Meeting Assistant',
  nav: { dashboard: 'Lịch sử Meeting', settings: 'Cài đặt' },
  dashboard: {
    title: 'Cuộc họp', loading: 'Đang tải…',
    sessions: n => `${n} phiên`,
    newMeeting: '+ Cuộc họp mới',
    importFile: 'Import âm thanh',
    emptyTitle: 'Chưa có cuộc họp nào',
    emptyHint: 'Bắt đầu cuộc họp mới hoặc import file âm thanh',
    deleteConfirm: 'Xóa phiên này?',
    diskWarn: 'Dung lượng đĩa thấp',
    diskBlock: 'Không đủ dung lượng để import',
    diskFree: 'trống',
    search: 'Tìm kiếm cuộc họp…', noResults: 'Không tìm thấy cuộc họp',
  },
  setup: {
    title: 'Cuộc họp mới', titleLabel: 'Tiêu đề',
    inputLang: 'Ngôn ngữ giọng nói',
    cancel: 'Hủy', start: '🎙 Bắt đầu ghi', starting: 'Đang khởi động…',
    failedToStart: 'Khởi động thất bại', langMulti: '🌐 Đa ngôn ngữ',
  },
  recording: { stopping: 'Đang dừng…', stop: '■ Dừng ghi' },
  import: {
    title: 'Import âm thanh', fileLabel: 'File', noFileSelected: 'Chưa chọn file',
    browse: 'Chọn file', noPathError: 'Không lấy được đường dẫn file',
    noAudioError: 'File không có track âm thanh', probeError: 'Không đọc được file',
    startImport: 'Bắt đầu import', importing: 'Đang xử lý…', failed: 'Import thất bại',
  },
  post: {
    loading: 'Đang tải…', processing: 'Đang xử lý…', error: 'Lỗi: ',
    tabs: { overview: 'Tóm tắt', transcript: 'Bản ghi', todos: 'Todo' },
    steps: {
      prepare_audio: 'Đang chuẩn bị âm thanh…',
      batch_stt: 'Đang nhận dạng âm thanh…', lang_detect: 'Đang phát hiện ngôn ngữ…',
      normalizing: 'Đang chuẩn hóa văn bản…', summarizing: 'AI đang tạo biên bản…', exporting: 'Đang xuất…',
    },
    duration: m => `${m} phút`,
    purpose: 'Mục đích', decisions: 'Quyết định', concerns: 'Mối lo ngại', nextActions: 'Hành động tiếp theo',
    generating: 'AI đang tạo biên bản họp…', noData: 'Không có dữ liệu',
    noTranscript: 'Không có bản ghi', noTodos: 'Không có việc cần làm',
    priority: { high: 'Cao', medium: 'Trung bình', low: 'Thấp' },
    todoCol: { task: 'Nhiệm vụ', assignee: 'Người thực hiện', deadline: 'Hạn chót' },
    retryStep: 'Thử lại', resumePipeline: 'Tiếp tục pipeline',
    todoCopy: 'Sao chép', todoCopied: 'Đã sao chép!', todoExport: 'Lưu Markdown',
    progressStep: (c, total) => `Bước ${c} / ${total}`,
  },
  status: { recording: 'Đang ghi', processing: 'Đang xử lý', done: 'Hoàn thành', error: 'Lỗi', error_recoverable: 'Có thể thử lại' },
  card: {
    delete: 'Xóa',
    duration: (m, s) => m > 0 ? `${m}p ${s}s` : `${s}s`,
  },
  settings: {
    title: 'Cài đặt', apiKeys: 'API Keys',
    apiKeysHint: 'Khóa được lưu trong OS keychain. Không gửi ra ngoài ứng dụng.',
    configured: 'Đã cấu hình', enterNewKey: 'Nhập khóa mới để cập nhật…', pasteKey: 'Dán API key…',
    save: 'Lưu', language: 'Ngôn ngữ', uiLanguage: 'Ngôn ngữ giao diện',
    whisperHint: 'Gợi ý ngôn ngữ Whisper', whisperAuto: 'Tự động phát hiện',
    device: 'Thiết bị', mic: 'Microphone', micN: i => `Mic ${i}`, systemDefault: 'Mặc định hệ thống',
    saveSettings: 'Lưu cài đặt', saving: 'Đang lưu…', saved: '✓ Đã lưu',
    storage: 'Lưu trữ',
    storageRoot: 'Vị trí lưu trữ', storageRootDefault: '(mặc định: AppData)', storageRootHint: 'Để trống để dùng đường dẫn mặc định',
    autoCleanupDays: 'Tự động xóa sau (ngày)', archiveSource: 'Giữ file gốc đã import',
    statsSessions: 'Số phiên', statsUsed: 'Đã dùng', statsFree: 'Còn trống', runCleanup: 'Dọn dẹp ngay',
  },
};

export const locales: Record<UILang, Locale> = { ja, en, vi };
