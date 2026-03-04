import type { MeetingMinutes, TranscriptSegment } from '../../shared/types';

function msToTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

class ExportService {
  toMarkdown(input: {
    title: string; startedAt: number; durationMs: number | null;
    minutes: MeetingMinutes | null; segments: TranscriptSegment[];
  }): string {
    const lines: string[] = [];
    const date = new Date(input.startedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const dur  = input.durationMs ? `${Math.floor(input.durationMs / 60000)}分` : '';
    lines.push(`# ${input.title}`, '', `**日時**: ${date}　**時間**: ${dur}`, '', '---', '');
    const m = input.minutes?.data;
    if (m) {
      lines.push('## 目的', '', m.purpose, '');
      if (m.decisions.length)    { lines.push('## 決定事項', ''); m.decisions.forEach(d => lines.push(`- ${d.text}${d.source_time ? ` (${d.source_time})` : ''}`)); lines.push(''); }
      if (m.todos.length)        {
        lines.push('## Todo', '', '| タスク | 担当者 | 期限 | 優先度 |', '|--------|--------|------|--------|');
        m.todos.forEach(t => lines.push(`| ${t.task} | ${t.assignee ?? '—'} | ${t.deadline ?? '—'} | ${t.priority} |`));
        lines.push('');
      }
      if (m.concerns.length)     { lines.push('## 懸念事項', ''); m.concerns.forEach(c => lines.push(`- ${c}`)); lines.push(''); }
      if (m.next_actions.length) { lines.push('## ネクストアクション', ''); m.next_actions.forEach(a => lines.push(`- ${a}`)); lines.push(''); }
    }
    if (input.segments.length) {
      lines.push('## 文字起こし', '');
      input.segments.forEach(s => lines.push(`**[${msToTime(s.startMs)}] ${s.speakerId}**: ${s.text}`, ''));
    }
    return lines.join('\n');
  }
}

export const exportService = new ExportService();
