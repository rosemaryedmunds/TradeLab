// PM2 process descriptor. Loads env from `.env` automatically (dotenv is
// initialized at the top of server/index.js).
module.exports = {
  apps: [{
    name: 'tradelab-v2',
    script: 'server/index.js',
    cwd: __dirname,
    autorestart: true,
    max_memory_restart: '256M',
    out_file: '/root/.pm2/logs/tradelab-v2-out.log',
    error_file: '/root/.pm2/logs/tradelab-v2-error.log'
  }]
};
