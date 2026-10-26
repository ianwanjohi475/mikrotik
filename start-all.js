// Starts both simulators in one window. Ctrl+C stops both.
const { spawn } = require('child_process');
const path = require('path');
const procs = ['oneisp', 'smartolt'].map(name => {
  const p = spawn(process.execPath, [path.join(__dirname, name, 'server.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = name === 'oneisp' ? '[OneISP]  ' : '[SmartOLT]';
  p.stdout.on('data', d => process.stdout.write(String(d).split('\n').filter(Boolean).map(l => `${tag} ${l}`).join('\n') + '\n'));
  p.stderr.on('data', d => process.stderr.write(`${tag} ${d}`));
  p.on('exit', code => console.log(`${tag} exited (${code})`));
  return p;
});
const stop = () => { procs.forEach(p => p.kill('SIGTERM')); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
