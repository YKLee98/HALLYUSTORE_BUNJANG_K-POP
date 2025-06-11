// src/app.js
// Express 애플리케이션 설정 및 구성

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const Bee = require('bullmq');
const basicAuth = require('express-basic-auth');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const config = require('./config');
const logger = require('./config/logger');
const mainErrorHandler = require('./utils/errorHandler');

// 웹훅 관련 임포트
const webhookRoutes = require('./routes/webhook.routes'); // 이미 작성된 webhook.routes.js 사용
const shopifyWebhookValidator = require('./middleware/shopifyWebhookValidator');
const orderSyncController = require('./controllers/orderSyncController');
const apiRoutes = require('./api');
const { getQueue } = require('./jobs/queues');

const app = express();

// --- 기본 보안 및 유틸리티 미들웨어 ---
app.disable('x-powered-by'); 

app.use(helmet({
  contentSecurityPolicy: config.env === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));

// CORS 설정
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || config.middlewareBaseUrl || '').split(',').map(o => o.trim()).filter(Boolean);
    if (config.env !== 'production' || !origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      logger.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Shopify-Hmac-Sha256', 'X-Api-Key', 'X-Request-ID'],
  exposedHeaders: ['Content-Length', 'X-Request-ID', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(compression());

// HTTP 요청 로깅
const morganFormat = config.env === 'production' ? 'short' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.http(message.trim()) },
  skip: (req, res) => (res.statusCode < 400 && config.env === 'production'),
}));

// --- BullMQ BullBoard 대시보드 설정 ---
if (config.env !== 'production' && config.redis.enabled) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/jobs');

  const queuesForBoard = Object.values(config.bullmq.queues).map(queueName => {
      const queueInstance = getQueue(queueName);
      if (queueInstance) {
          return new BullMQAdapter(queueInstance);
      }
      logger.warn(`[BullBoard] 큐 "${queueName}"의 인스턴스를 찾을 수 없어 대시보드에 추가하지 못했습니다.`);
      return null;
  }).filter(q => q !== null);

  if (queuesForBoard.length > 0) {
      createBullBoard({
          queues: queuesForBoard,
          serverAdapter: serverAdapter,
          options: {
              uiConfig: {
                  boardTitle: config.appName || 'Bunjang-Shopify Jobs',
              }
          }
      });

      const arenaUsers = {};
      arenaUsers[config.bullmq.arenaAdmin.username] = config.bullmq.arenaAdmin.password;

      app.use('/admin/jobs', basicAuth({ users: arenaUsers, challenge: true, realm: 'BullBoardMonitor' }), serverAdapter.getRouter());
      logger.info(`Bull Board UI available at /admin/jobs. User: ${config.bullmq.arenaAdmin.username}`);
  } else {
      logger.warn('[BullBoard] 대시보드에 연결할 유효한 BullMQ 큐를 찾지 못했습니다.');
  }
} else if (config.env === 'production' && config.redis.enabled) {
    logger.info('Bull Board UI is typically disabled or access-restricted in production. Ensure strong authentication if enabled.');
}

// --- 중요: Raw Body 캡처를 위한 미들웨어 (JSON 파서보다 먼저 와야 함) ---
// bodyParser.json with verify callback to capture raw body for webhooks
app.use(bodyParser.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    // 웹훅 경로에 대해서만 raw body 저장
    if (req.originalUrl.startsWith('/webhook') || 
        req.originalUrl.startsWith('/webhooks')) {
      req.rawBody = buf;
    }
  }
}));

// URL-encoded 파싱
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Shopify 웹훅 라우트 (webhook.routes.js 사용) ---
// /webhook 경로로 마운트 (현재 작동 중인 경로)
app.use('/webhook', webhookRoutes);

// /webhooks 경로도 동일하게 처리 (Shopify 설정에 따라)
app.use('/webhooks', webhookRoutes);

// 기존 코드에 있던 /webhooks/shopify 경로 처리 (필요한 경우)
const shopifyWebhookRouter = express.Router();
shopifyWebhookRouter.post('/orders-create', 
  shopifyWebhookValidator,
  orderSyncController.handleShopifyOrderCreateWebhook
);
app.use('/webhooks/shopify', shopifyWebhookRouter);

// API 요청 제한 (Rate Limiting) - 웹훅 경로는 제외
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: 'draft-7', 
  legacyHeaders: false,
  message: { error: '요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit exceeded for IP ${req.ip || req.socket.remoteAddress}: ${options.message.error}`, { path: req.originalUrl });
    res.status(options.statusCode).json(options.message);
  },
  skip: (req) => {
    // 웹훅 경로는 rate limit 제외
    return req.originalUrl.startsWith('/webhook') || req.originalUrl.startsWith('/webhooks');
  }
});
app.use('/api', apiLimiter);

// 통합 API 라우터 마운트
app.use('/api', apiRoutes);

// --- 기본 헬스 체크 및 서비스 상태 라우트 ---
app.get('/', (req, res) => {
  res.status(200).json({
    application: config.appName,
    version: config.version,
    status: 'running',
    environment: config.env,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res, next) => {
  let dbHealthy = false;
  let redisHealthy = false;
  
  try {
    const mongoose = require('mongoose');
    dbHealthy = mongoose.connection.readyState === 1;

    if (config.redis.enabled) {
      const redisClient = require('./config/redisClient').getRedisClient();
      if (redisClient && redisClient.status === 'ready') {
        await redisClient.ping();
        redisHealthy = true;
      }
    } else {
      redisHealthy = true;
    }
    
    const overallHealthy = dbHealthy && redisHealthy;
    const statusCode = overallHealthy ? 200 : 503;

    res.status(statusCode).json({ 
        status: overallHealthy ? 'UP' : 'DEGRADED', 
        timestamp: new Date().toISOString(),
        dependencies: {
            database: dbHealthy ? 'UP' : 'DOWN',
            redis: config.redis.enabled ? (redisHealthy ? 'UP' : 'DOWN') : 'DISABLED',
        }
    });
  } catch (error) {
    logger.error('[HealthCheck] Error during health check:', error);
    const { AppError } = require('./utils/customErrors');
    next(new AppError('헬스 체크 중 오류 발생', 500, 'HEALTH_CHECK_ERROR', false, error));
  }
});

// --- 404 핸들러 ---
app.use((req, res, next) => {
  const { NotFoundError } = require('./utils/customErrors');
  next(new NotFoundError(`요청하신 API 엔드포인트 '${req.method} ${req.originalUrl}'를 찾을 수 없습니다.`));
});

// --- 중앙 집중식 에러 핸들러 ---
app.use(mainErrorHandler);

module.exports = app;