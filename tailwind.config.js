/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./renderer/index.html', './renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:              '#0f1117',
        surface:         '#161b2e',
        'surface-2':     '#1d2540',
        border:          '#252d47',
        'text-primary':  '#e2e8f0',
        'text-muted':    '#64748b',
        'text-dim':      '#94a3b8',
        accent:          '#6366f1',
        'accent-hover':  '#4f46e5',
        'accent-subtle': 'rgba(99,102,241,0.08)',
      },
    },
  },
};
