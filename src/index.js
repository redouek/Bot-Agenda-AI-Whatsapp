import { loadConfig, isConfigComplete } from './config.js';
import { startServer } from './server.js';
import { startBot } from './bot.js';

loadConfig();

const PORT = parseInt(process.env.PORT || '3000', 10);
startServer(PORT);

if (isConfigComplete()) {
  startBot().catch(err => console.error('[index] Erro ao iniciar bot:', err));
} else {
  console.log('[index] Configuração incompleta — acesse http://localhost:' + PORT + ' para configurar.');
}
