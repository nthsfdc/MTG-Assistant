#!/usr/bin/env node
// Cross-platform dev launcher: removes ELECTRON_RUN_AS_NODE from environment.
// When set (even to empty string), Electron treats itself as plain Node.js,
// blocking all Electron APIs. Claude Code sets this automatically.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const bin = require('path').join(__dirname, '../node_modules/.bin/electron-vite.cmd');
const child = spawn(bin, ['dev'], { stdio: 'inherit', shell: true, env });
child.on('close', code => process.exit(code ?? 0));
child.on('error', err => { console.error('[dev.js]', err.message); process.exit(1); });
