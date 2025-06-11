// src/config/index.js
// 환경 변수를 로드하고 애플리케이션 전체에서 사용할 수 있도록 통합된 설정 객체를 제공합니다.
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs'); // 파일 시스템 모듈 (env 파일 존재 확인용)

// NODE_ENV에 따라 다른 .env 파일 로드 시도, 없으면 기본 .env 파일 로드
// 예: .env.production, .env.development
const envSpecificPath = path.resolve(__dirname, `../../.env.${process.env.NODE_ENV}`);
const defaultEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(envSpecificPath)) {
  dotenv.config({ path: envSpecificPath });
  console.log(`[ConfigLoader] Loaded environment variables from: ${envSpecificPath}`);
} else if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
  console.log(`[ConfigLoader] Loaded environment variables from: ${defaultEnvPath}`);
} else {
  console.warn(`[ConfigLoader] No .env file found at ${envSpecificPath} or ${defaultEnvPath}. Using platform environment variables only.`);
}


const packageJson = require('../../package.json');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  middlewareBaseUrl: process.env.MIDDLEWARE_BASE_URL,
  version: packageJson.version,
  appName: packageJson.name || 'bunjang-shopify-middleware',

  internalApiKey: process.env.INTERNAL_API_KEY,

  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiScopes: process.env.SHOPIFY_API_SCOPES ? process.env.SHOPIFY_API_SCOPES.split(',').map(s => s.trim()) : [],
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-04",
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    defaultLocationId: process.env.SHOPIFY_DEFAULT_LOCATION_ID,
    onlineStorePublicationGid: process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_GID,
    defaultCollectionGid: process.env.SHOPIFY_BUNJANG_COLLECTION_GID,
    appProxy: {
        subpathPrefix: process.env.SHOPIFY_APP_PROXY_SUBPATH_PREFIX || 'bunjang-proxy', // Shopify Admin 설정과 일치
    }
  },

  bunjang: {
    generalApiUrl: process.env.BUNJANG_API_GENERAL_URL,
    catalogApiUrl: process.env.BUNJANG_CATALOG_API_URL,
    accessKey: process.env.BUNJANG_API_ACCESS_KEY,
    secretKey: process.env.BUNJANG_API_SECRET_KEY,
    kpopKeywords: ['bts', 'blackpink'],
    kidultKeywords: ['collectible', 'limited edition'],
    apiTimeoutMs: parseInt(process.env.BUNJANG_API_TIMEOUT_MS, 10) || 60000,
    catalogDownloadTimeoutMs: parseInt(process.env.BUNJANG_CATALOG_DOWNLOAD_TIMEOUT_MS, 10) || 300000,
    filterCategoryIds: process.env.BUNJANG_FILTER_CATEGORY_IDS ? process.env.BUNJANG_FILTER_CATEGORY_IDS.split(',').map(id => id.trim()) : [],
    categoryToShopifyType: {
      ...(Object.keys(process.env)
        .filter(key => key.startsWith('BUNJANG_CATEGORY_TO_SHOPIFY_TYPE_'))
        .reduce((obj, key) => {
          const categoryId = key.replace('BUNJANG_CATEGORY_TO_SHOPIFY_TYPE_', '');
          obj[categoryId.trim()] = process.env[key].trim();
          return obj;
        }, {})),
    },
    defaultShopifyProductType: process.env.BUNJANG_DEFAULT_SHOPIFY_PRODUCT_TYPE || "Bunjang Linked Product",
    orderIdentifierPrefix: process.env.BUNJANG_ORDER_IDENTIFIER_PREFIX || "bungjang_order_",
    
    // 포인트 관리 설정
    lowBalanceThreshold: parseInt(process.env.BUNJANG_LOW_BALANCE_THRESHOLD, 10) || 1000000, // 기본 100만원
    criticalBalanceThreshold: parseInt(process.env.BUNJANG_CRITICAL_BALANCE_THRESHOLD, 10) || 500000, // 기본 50만원
    
    // 주문 동기화 설정
    enableFrequentSync: process.env.BUNJANG_ENABLE_FREQUENT_SYNC || 'false', // 30분마다 동기화 활성화
    orderSyncInterval: parseInt(process.env.BUNJANG_ORDER_SYNC_INTERVAL_MINUTES, 10) || 30, // 동기화 간격 (분)
    
    // 배송지 정보
    csTrading: {
        recipientName1: process.env.CS_TRADING_BUNJANG_RECIPIENT_NAME_1 || "(번장)문장선",
        recipientName2: process.env.CS_TRADING_BUNJANG_RECIPIENT_NAME_2 || "(번장)씨에스트레이딩",
        shippingAddress: process.env.CS_TRADING_BUNJANG_SHIPPING_ADDRESS || "서울시 금천구 디지털로 130, 남성프라자 908호",
        zipCode: process.env.CS_TRADING_BUNJANG_ZIP_CODE || "08589",
        phone: process.env.CS_TRADING_BUNJANG_PHONE || "02-123-4567",
    },
    
    // API 토큰 (구버전 호환용 - 실제로는 JWT 사용)
    apiToken: process.env.BUNJANG_API_TOKEN || null,
    
    // 기본 벤더명 추가
    defaultVendor: process.env.BUNJANG_DEFAULT_VENDOR || "BunjangImport",
    
    // 동기화 동시성 설정
    syncConcurrency: parseInt(process.env.BUNJANG_SYNC_CONCURRENCY, 10) || 1,
  },

  openExchangeRates: {
    appId: process.env.OPENEXCHANGERATES_APP_ID,
    apiUrl: process.env.OPENEXCHANGERATES_API_URL || "https://openexchangerates.org/api",
  },

  priceCalculation: {
    // 가격이 0원이 되지 않도록 기본값을 명확히 설정 - 기본값 10%로 변경
    markupPercentage: (() => {
      const envValue = process.env.PRICE_MARKUP_PERCENTAGE;
      if (!envValue || envValue === '') {
        console.log('[Config] PRICE_MARKUP_PERCENTAGE not set, using default 10%');
        return 10; // 환경변수가 없으면 기본값 10%
      }
      const parsed = parseFloat(envValue);
      if (isNaN(parsed) || parsed < 0) {
        console.error(`[Config] Invalid PRICE_MARKUP_PERCENTAGE: ${envValue}, using default 10%`);
        return 10;
      }
      console.log(`[Config] PRICE_MARKUP_PERCENTAGE set to ${parsed}%`);
      return parsed;
    })(),
    handlingFeeUsd: (() => {
      const envValue = process.env.HANDLING_FEE_USD;
      if (!envValue || envValue === '') {
        console.log('[Config] HANDLING_FEE_USD not set, using default $5');
        return 5.00; // 환경변수가 없으면 기본값 $5
      }
      const parsed = parseFloat(envValue);
      if (isNaN(parsed) || parsed < 0) {
        console.error(`[Config] Invalid HANDLING_FEE_USD: ${envValue}, using default $5`);
        return 5.00;
      }
      console.log(`[Config] HANDLING_FEE_USD set to $${parsed}`);
      return parsed;
    })(),
  },

  database: {
    connectionString: process.env.DB_CONNECTION_STRING || `mongodb://localhost:27017/bunjangShopifyIntegrationDB_${process.env.NODE_ENV || 'development'}`,
    options: {
      autoIndex: process.env.NODE_ENV === 'development',
      serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS, 10) || 5000,
      connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 10000, // 연결 타임아웃
    }
  },

  redis: {
    enabled: process.env.REDIS_ENABLED === 'true',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    connectionOptions: {
        maxRetriesPerRequest: process.env.NODE_ENV === 'production' ? 20 : (parseInt(process.env.REDIS_MAX_RETRIES, 10) || 3),
        enableReadyCheck: false,
        enableOfflineQueue: true,
        // TLS 관련 설정 추가 가능
    }
  },

  logging: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    logDir: path.resolve(__dirname, process.env.LOG_DIR || '../../logs'),
    logFileBaseName: process.env.LOG_FILE_BASE_NAME || packageJson.name || 'app',
    maxSize: process.env.LOG_MAX_SIZE || '20m',
    maxFiles: process.env.NODE_ENV === 'production' ? (process.env.LOG_MAX_FILES_PROD || '30d') : (process.env.LOG_MAX_FILES_DEV || '7d'),
    handleExceptions: process.env.LOG_HANDLE_EXCEPTIONS !== 'false',
    handleRejections: process.env.LOG_HANDLE_REJECTIONS !== 'false',
  },

  scheduler: {
    fetchFullCatalogCron: process.env.FETCH_FULL_CATALOG_CRON || "30 3 * * *",
    fetchSegmentCatalogCron: process.env.FETCH_SEGMENT_CATALOG_CRON || "10 */1 * * *", // 매시간 10분으로 수정
    updateExchangeRatesCron: process.env.UPDATE_EXCHANGE_RATES_CRON || "0 */3 * * *",
    
    // 주문 상태 동기화 크론
    orderStatusSyncHourlyCron: process.env.ORDER_STATUS_SYNC_HOURLY_CRON || "0 * * * *", // 매시간 정각
    orderStatusSyncDailyCron: process.env.ORDER_STATUS_SYNC_DAILY_CRON || "0 2 * * *", // 매일 오전 2시
    orderStatusSyncFrequentCron: process.env.ORDER_STATUS_SYNC_FREQUENT_CRON || "*/30 * * * *", // 30분마다
    
    timezone: process.env.CRON_TIMEZONE || "Asia/Seoul",
    
    // 스케줄러 활성화 설정
    enableOrderSyncScheduler: process.env.ENABLE_ORDER_SYNC_SCHEDULER !== 'false', // 기본값 true
  },

  jwt: {
    expirationSeconds: parseInt(process.env.JWT_EXPIRATION_SECONDS, 10) || 4,
  },

  // BullMQ 작업 큐 설정 (jobQueue로 통합)
  jobQueue: {
    defaultJobOptions: {
      attempts: parseInt(process.env.JOB_DEFAULT_ATTEMPTS, 10) || 3,
      backoff: {
        type: process.env.JOB_BACKOFF_TYPE || 'exponential',
        delay: parseInt(process.env.JOB_BACKOFF_DELAY_MS, 10) || 2000,
      },
      removeOnComplete: {
        age: parseInt(process.env.JOB_REMOVE_ON_COMPLETE_AGE_HOURS, 10) || 24, // 24시간
        count: parseInt(process.env.JOB_REMOVE_ON_COMPLETE_COUNT, 10) || 100,
      },
      removeOnFail: {
        age: parseInt(process.env.JOB_REMOVE_ON_FAIL_AGE_HOURS, 10) || 72, // 72시간 (3일)
        count: parseInt(process.env.JOB_REMOVE_ON_FAIL_COUNT, 10) || 1000,
      },
    },
    // 워커별 동시 처리 수
    concurrency: {
      catalogSync: parseInt(process.env.WORKER_CATALOG_SYNC_CONCURRENCY, 10) || 1,
      orderProcessing: parseInt(process.env.WORKER_ORDER_PROCESSING_CONCURRENCY, 10) || 1,
      priceSync: parseInt(process.env.WORKER_PRICE_SYNC_CONCURRENCY, 10) || 2,
      inventorySync: parseInt(process.env.WORKER_INVENTORY_SYNC_CONCURRENCY, 10) || 2,
    },
    // BullMQ Arena (작업 대시보드) 설정
    arena: {
      enabled: process.env.ARENA_ENABLED !== 'false', // 기본 활성화
      port: parseInt(process.env.ARENA_PORT, 10) || 4567,
      host: process.env.ARENA_HOST || '0.0.0.0',
      basePath: process.env.ARENA_BASE_PATH || '/admin/jobs',
      disableListen: process.env.ARENA_DISABLE_LISTEN === 'true', // Express 앱에 마운트할 경우 true
      adminPassword: process.env.ARENA_ADMIN_PASSWORD || 'admin', // 반드시 변경
    }
  },

  // bullmq 설정 (레거시 호환성)
  bullmq: {
    defaultJobOptions: {
      attempts: parseInt(process.env.BULLMQ_DEFAULT_JOB_ATTEMPTS, 10) || 3,
      backoff: {
        type: 'exponential',
        delay: parseInt(process.env.BULLMQ_DEFAULT_BACKOFF_DELAY_MS, 10) || 5000,
      },
      removeOnComplete: { count: parseInt(process.env.BULLMQ_REMOVE_COMPLETE_COUNT, 10) || 1000, age: (parseInt(process.env.BULLMQ_REMOVE_COMPLETE_AGE_HOURS, 10) || 24) * 3600 },
      removeOnFail: { count: parseInt(process.env.BULLMQ_REMOVE_FAIL_COUNT, 10) || 5000, age: (parseInt(process.env.BULLMQ_REMOVE_FAIL_AGE_DAYS, 10) || 7) * 24 * 3600 },
    },
    queues: {
      catalog: process.env.BULLMQ_QUEUE_CATALOG || 'catalog-processing-queue',
      productSync: process.env.BULLMQ_QUEUE_PRODUCT_SYNC || 'product-sync-queue', // 개별 상품 동기화용 큐
      order: process.env.BULLMQ_QUEUE_ORDER || 'order-processing-queue',
      orderStatusSync: process.env.BULLMQ_QUEUE_ORDER_STATUS_SYNC || 'order-status-sync-queue', // 주문 상태 동기화 큐
      exchangeRate: process.env.BULLMQ_QUEUE_EXCHANGE_RATE || 'exchange-rate-update-queue',
    },
    arenaAdmin: { // BullMQ Arena UI 인증
        username: process.env.ARENA_ADMIN_USERNAME || 'arena_admin_user', // 반드시 변경
        password: process.env.ARENA_ADMIN_PASSWORD || 'P@$$wOrdArena123!', // 반드시 변경
    }
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'development' ? 2000 : (parseInt(process.env.RATE_LIMIT_MAX, 10) || 200),
  },

  tempDir: path.resolve(__dirname, process.env.TEMP_DIR || '../../temp_downloads'),
  
  // 알림 설정 (이메일, Slack 등)
  notifications: {
    enabled: process.env.NOTIFICATIONS_ENABLED === 'true',
    
    // 이메일 알림
    email: {
      enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === 'true',
      smtp: {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      },
      from: process.env.EMAIL_FROM || 'noreply@bunjang-shopify.com',
      adminRecipients: process.env.ADMIN_EMAIL_RECIPIENTS ? process.env.ADMIN_EMAIL_RECIPIENTS.split(',').map(e => e.trim()) : [],
    },
    
    // Slack 알림
    slack: {
      enabled: process.env.SLACK_NOTIFICATIONS_ENABLED === 'true',
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      channel: process.env.SLACK_CHANNEL || '#bunjang-shopify-alerts',
      username: process.env.SLACK_USERNAME || 'Bunjang-Shopify Bot',
    },
    
    // 알림 임계값
    thresholds: {
      pointBalanceLow: parseInt(process.env.NOTIFICATION_POINT_BALANCE_LOW, 10) || 1000000, // 100만원
      pointBalanceCritical: parseInt(process.env.NOTIFICATION_POINT_BALANCE_CRITICAL, 10) || 500000, // 50만원
      orderFailureCount: parseInt(process.env.NOTIFICATION_ORDER_FAILURE_COUNT, 10) || 5, // 연속 5회 실패
    },
  },
  
  // 환경별 추가 설정
  forceResyncAll: process.env.FORCE_RESYNC_ALL === 'true', // 모든 상품 강제 재동기화
};

// 필수 환경 변수 검증 함수
function validateRequiredConfig(loggerInstance) {
  const requiredEnvVars = [
    'MIDDLEWARE_BASE_URL',
    'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_DEFAULT_LOCATION_ID',
    'BUNJANG_API_GENERAL_URL', 'BUNJANG_CATALOG_API_URL', 'BUNJANG_API_ACCESS_KEY', 'BUNJANG_API_SECRET_KEY',
    'OPENEXCHANGERATES_APP_ID',
    'DB_CONNECTION_STRING',
    'INTERNAL_API_KEY',
    'ARENA_ADMIN_PASSWORD',
  ];
  
  // 선택적 환경 변수 (경고만 표시)
  const optionalEnvVars = [
    'BUNJANG_LOW_BALANCE_THRESHOLD',
    'BUNJANG_CRITICAL_BALANCE_THRESHOLD',
    'CS_TRADING_BUNJANG_RECIPIENT_NAME_1',
    'CS_TRADING_BUNJANG_SHIPPING_ADDRESS',
    'ENABLE_ORDER_SYNC_SCHEDULER',
  ];
  
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  const missingOptionalVars = optionalEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    const errorMsg = `FATAL ERROR: Missing required environment variables: ${missingVars.join(', ')}. Please check your .env file(s).`;
    if (loggerInstance && typeof loggerInstance.error === 'function') {
      loggerInstance.error(`[ConfigValidation] ${errorMsg}`);
    } else {
      console.error(`[ConfigValidation] ${errorMsg}`);
    }
    process.exit(1);
  }
  
  if (missingOptionalVars.length > 0) {
    const warningMsg = `Missing optional environment variables (using defaults): ${missingOptionalVars.join(', ')}`;
    if (loggerInstance && typeof loggerInstance.warn === 'function') {
      loggerInstance.warn(`[ConfigValidation] ${warningMsg}`);
    } else {
      console.warn(`[ConfigValidation] ${warningMsg}`);
    }
  }
  
  // 프로덕션 환경 보안 검증
  if (config.env === 'production' && 
      (process.env.ARENA_ADMIN_PASSWORD === 'P@$$wOrdArena123!' || 
       process.env.ARENA_ADMIN_PASSWORD === 'supersecretpassword123' ||
       process.env.ARENA_ADMIN_PASSWORD === 'admin' ||
       process.env.INTERNAL_API_KEY === 'a_very_strong_and_secret_api_key_for_internal_use_123!@#')) {
      const errorMsg = "CRITICAL SECURITY WARNING: Default Arena admin password or Internal API Key is being used in production. This is a SEVERE security risk. Please change these values immediately in your production .env file.";
      if (loggerInstance && typeof loggerInstance.error === 'function') {
        loggerInstance.error(`[ConfigValidation] ${errorMsg}`);
      } else {
        console.error(`[ConfigValidation] ${errorMsg}`);
      }
      process.exit(1); // 보안 문제로 강제 종료
  }
  
  // 로케이션 ID 검증 - 숫자형 ID와 GID 형식 모두 허용
  if (process.env.SHOPIFY_DEFAULT_LOCATION_ID) {
    const locationId = process.env.SHOPIFY_DEFAULT_LOCATION_ID;
    // 숫자형 ID 또는 GID 형식 모두 허용
    const isNumericId = /^\d+$/.test(locationId);
    const isGid = /^gid:\/\/shopify\/Location\/\d+$/.test(locationId);
    
    if (!isNumericId && !isGid) {
      const errorMsg = `SHOPIFY_DEFAULT_LOCATION_ID must be either a numeric ID or a GraphQL ID (GID). Got: ${locationId}. Example: '82604261625' or 'gid://shopify/Location/82604261625'`;
      if (loggerInstance && typeof loggerInstance.error === 'function') {
        loggerInstance.error(`[ConfigValidation] ${errorMsg}`);
      } else {
        console.error(`[ConfigValidation] ${errorMsg}`);
      }
      process.exit(1);
    }
  }
  
  // 가격 계산 설정 검증
  if (process.env.PRICE_MARKUP_PERCENTAGE) {
    const markup = parseFloat(process.env.PRICE_MARKUP_PERCENTAGE);
    if (isNaN(markup) || markup < 0) {
      const warnMsg = `PRICE_MARKUP_PERCENTAGE should be a positive number. Got: ${process.env.PRICE_MARKUP_PERCENTAGE}. Using default: 10%`;
      if (loggerInstance && typeof loggerInstance.warn === 'function') {
        loggerInstance.warn(`[ConfigValidation] ${warnMsg}`);
      } else {
        console.warn(`[ConfigValidation] ${warnMsg}`);
      }
    }
  }
  
  if (process.env.HANDLING_FEE_USD) {
    const fee = parseFloat(process.env.HANDLING_FEE_USD);
    if (isNaN(fee) || fee < 0) {
      const warnMsg = `HANDLING_FEE_USD should be a positive number. Got: ${process.env.HANDLING_FEE_USD}. Using default: $5`;
      if (loggerInstance && typeof loggerInstance.warn === 'function') {
        loggerInstance.warn(`[ConfigValidation] ${warnMsg}`);
      } else {
        console.warn(`[ConfigValidation] ${warnMsg}`);
      }
    }
  }
}

// validateRequiredConfig를 config 객체에 추가
config.validateRequiredConfig = validateRequiredConfig;

module.exports = config;