// PM2 process file for pos-api. `deploy/linux/install.sh` starts it and runs
// `pm2 startup` + `pm2 save` so it starts on boot. Settings come from the
// environment file given in POS_ENV_FILE (default /etc/dhaba-pos/pos-api.env).
const fs = require('fs');
const path = require('path');

const envFile = process.env.POS_ENV_FILE || '/etc/dhaba-pos/pos-api.env';
const env = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
}

module.exports = {
  apps: [
    {
      name: 'pos-api',
      script: path.join(__dirname, '../../apps/pos-api/dist/main.js'),
      cwd: path.join(__dirname, '../..'),
      instances: 1, // exactly one process: it holds the folder lock and the write queue
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      // Fits a 1 vCPU / 1 GB VPS: cap the V8 heap and restart before the kernel OOM-kills.
      node_args: `--max-old-space-size=${env.NODE_MAX_OLD_SPACE_MB || 512}`,
      max_memory_restart: env.PM2_MAX_MEMORY || '750M',
      kill_timeout: 10000,
      env,
    },
  ],
};
