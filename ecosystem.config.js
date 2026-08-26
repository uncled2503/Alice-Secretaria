// Config do pm2 pra rodar em producao com reinicio automatico se cair.
// Uso: npm run build && npm run pm2:start
module.exports = {
  apps: [
    {
      name: "alice",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
