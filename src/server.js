// src/server.js
const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');

const PORT = config.port || 3000;

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT} in ${config.env} mode`);
  logger.info(`Webhook endpoint: http://localhost:${PORT}/webhook/*`);
  
  if (config.shopify.webhookSecret) {
    logger.info('Shopify webhook secret is configured');
  } else {
    logger.error('WARNING: SHOPIFY_WEBHOOK_SECRET is not set!');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});