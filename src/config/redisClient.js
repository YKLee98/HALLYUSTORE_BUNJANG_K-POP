// src/config/redisClient.js
// IORedis 클라이언트 설정 및 BullMQ에서 사용할 연결 옵션을 제공합니다.

const Redis = require('ioredis');
const config = require('./index'); // ./index.js는 dotenv를 이미 호출했다고 가정
const logger = require('./logger'); // ./logger.js는 Winston 로거

let sharedRedisClientInstance; // 공유 클라이언트 인스턴스 (이름 변경으로 명확성 확보)
let healthCheckIntervalId;

// --- 일반 공유 Redis 클라이언트를 위한 기본 연결 옵션 ---
const baseRedisConnectionOptions = {
  host: config.redis.host,
  port: config.redis.port,
  ...(config.redis.password && { password: config.redis.password }),
  // 일반 클라이언트의 경우, maxRetriesPerRequest는 설정 파일 또는 기본값을 따름
  maxRetriesPerRequest: config.redis.connectionOptions?.maxRetriesPerRequest === null 
                          ? null 
                          : (config.redis.connectionOptions?.maxRetriesPerRequest || 10), // 기존 로직 유지 또는 조정
  enableReadyCheck: config.redis.connectionOptions?.enableReadyCheck || true, // 일반적으로 true가 안전
  retryStrategy(times) {
    const maxRetries = config.redis.connectionOptions?.maxRetries || 10; // 설정 또는 기본값
    if (times > maxRetries) {
      logger.error(`[RedisClient-Shared] Redis 연결 재시도 횟수 초과 (${times}번). 더 이상 시도하지 않습니다.`);
      return null; // 더 이상 재시도 안 함
    }
    const delay = Math.min(times * (config.redis.connectionOptions?.retryDelayMultiplier || 200), 
                           (config.redis.connectionOptions?.maxRetryDelay || 3000));
    logger.warn(`[RedisClient-Shared] Redis 연결 재시도 중... (${times}번째 시도, ${delay}ms 후)`);
    return delay;
  },
  showFriendlyErrorStack: config.env === 'development', // 개발 환경에서 상세 에러 스택 표시
  // TLS 설정 (필요시 주석 해제 및 경로 설정)
  // tls: config.redis.tlsEnabled ? {
  //   ca: fs.readFileSync(config.redis.tlsCaPath),
  //   key: fs.readFileSync(config.redis.tlsKeyPath),
  //   cert: fs.readFileSync(config.redis.tlsCertPath),
  //   rejectUnauthorized: config.redis.tlsRejectUnauthorized !== 'false',
  // } : undefined,
};

// --- BullMQ 전용 Redis 연결 옵션 ---
// 기본 옵션을 복사하고 BullMQ 요구사항에 맞게 maxRetriesPerRequest를 null로 강제 설정
const bullmqDedicatedRedisConnectionOptions = {
  ...baseRedisConnectionOptions, // 기본 옵션 상속
  maxRetriesPerRequest: null,    // BullMQ는 이것이 반드시 null이어야 함!
  enableOfflineQueue: false,     // BullMQ는 일반적으로 false를 권장
  // BullMQ를 위한 retryStrategy는 ioredis의 기본값을 사용하거나, 여기서 다르게 설정 가능.
  // 다만, maxRetriesPerRequest: null 설정이 이 오류의 핵심 수정 사항임.
  // 만약 BullMQ 전용으로 다른 retryStrategy를 원한다면 여기서 오버라이드:
  // retryStrategy: function(times) { /* BullMQ 전용 재시도 로직 */ return Math.min(times * 50, 2000); },
};


/**
 * 공유 가능한 Redis 클라이언트 인스턴스를 가져옵니다.
 * Redis가 비활성화된 경우 null을 반환합니다.
 * @returns {Redis.Redis|null} IORedis 클라이언트 인스턴스 또는 null.
 */
function getRedisClient() {
  if (!config.redis.enabled) {
    logger.warn('[RedisClient-Shared] Redis is disabled in configuration. Operations requiring Redis may fail or use fallback.');
    return null;
  }

  // 'connecting' 상태도 유효한 진행 중 상태로 간주하여 새 인스턴스 생성을 방지
  if (!sharedRedisClientInstance || !['connect', 'ready', 'connecting'].includes(sharedRedisClientInstance.status)) {
    // 기존 클라이언트가 있지만 'end' 상태(완전히 종료)인 경우, 새 연결 시도
    if (sharedRedisClientInstance && sharedRedisClientInstance.status === 'end') {
        logger.warn(`[RedisClient-Shared] Existing shared Redis client status is 'end'. Creating a new connection.`);
    } else if (sharedRedisClientInstance) { // 'connecting' 외의 다른 불안정한 상태일 수 있음
        logger.warn(`[RedisClient-Shared] Existing shared Redis client status is '${sharedRedisClientInstance.status}'. Attempting to create a new connection.`);
    }

    logger.info(`[RedisClient-Shared] Creating new shared Redis connection to ${config.redis.host}:${config.redis.port}`);
    // 일반 공유 클라이언트는 baseRedisConnectionOptions 사용
    // ioredis 생성자: new Redis(port, host, options) 또는 new Redis(options)
    // baseRedisConnectionOptions에 host, port가 이미 있으므로 new Redis(baseRedisConnectionOptions) 사용 가능
    sharedRedisClientInstance = new Redis(baseRedisConnectionOptions);

    sharedRedisClientInstance.on('connect', () => {
      logger.info('[RedisClient-Shared] Shared Redis client: connection established.');
    });
    
    sharedRedisClientInstance.on('ready', () => {
        logger.info('[RedisClient-Shared] Shared Redis client: ready to use.');
        if (healthCheckIntervalId) clearInterval(healthCheckIntervalId);
        healthCheckIntervalId = setInterval(async () => {
          if (sharedRedisClientInstance && sharedRedisClientInstance.status === 'ready') {
            try {
              await sharedRedisClientInstance.ping();
              // logger.debug('[RedisClient-Shared] Shared Redis PING successful.');
            } catch (pingError) {
              logger.error('[RedisClient-Shared] Shared Redis PING failed while client was ready:', pingError);
            }
          }
        }, 30000); // 30초마다 PING
    });

    sharedRedisClientInstance.on('error', (err) => {
      logger.error('[RedisClient-Shared] Shared Redis client error:', { message: err.message, code: err.code, address: err.address, port: err.port });
    });

    sharedRedisClientInstance.on('reconnecting', () => { // ioredis v4+에서는 delay 인자 없음
      logger.warn(`[RedisClient-Shared] Shared Redis client: reconnecting...`);
    });

    sharedRedisClientInstance.on('end', () => {
      logger.info('[RedisClient-Shared] Shared Redis client connection ended.');
      if (healthCheckIntervalId) {
        clearInterval(healthCheckIntervalId);
        healthCheckIntervalId = null;
      }
      // 'end' 상태 후 자동 재연결 안 함. getRedisClient() 재호출 시 새 인스턴스 생성 유도.
      sharedRedisClientInstance = null; 
    });
  }
  return sharedRedisClientInstance;
}

/**
 * 공유 Redis 클라이언트 연결을 정상적으로 종료합니다.
 * 애플리케이션 종료 시 호출됩니다.
 */
async function disconnectRedis() {
  if (sharedRedisClientInstance) {
    logger.info('[RedisClient-Shared] Disconnecting shared Redis client...');
    if (healthCheckIntervalId) {
      clearInterval(healthCheckIntervalId);
      healthCheckIntervalId = null;
    }
    try {
      await sharedRedisClientInstance.quit();
      logger.info('[RedisClient-Shared] Shared Redis client disconnected successfully.');
    } catch (error) {
      logger.error('[RedisClient-Shared] Error during shared Redis client disconnection:', error);
    } finally {
      sharedRedisClientInstance = null; 
    }
  } else {
    logger.info('[RedisClient-Shared] Shared Redis client was not initialized or already disconnected.');
  }
}

/**
 * BullMQ에서 사용할 새 Redis 연결 인스턴스를 반환합니다.
 * 이 연결은 BullMQ의 요구사항에 맞게 'maxRetriesPerRequest: null'로 설정됩니다.
 * @returns {Redis.Redis} 새 IORedis 클라이언트 인스턴스.
 * @throws {Error} Redis가 비활성화된 경우.
 */
function getBullMQRedisConnection() {
    if (!config.redis.enabled) {
        // 이 에러는 BullMQ 큐/워커 초기화 시점에서 잡힐 것임
        logger.error("[RedisClient-BullMQ] Redis is not enabled in the configuration, BullMQ cannot be initialized.");
        throw new Error("Redis is not enabled in the configuration, BullMQ cannot be initialized.");
    }
    // BullMQ는 연결 옵션 객체 또는 ioredis 인스턴스를 받을 수 있습니다.
    // 매번 새 인스턴스를 생성하여 BullMQ가 독립적으로 관리하도록 합니다.
    // BullMQ 전용으로 수정된 옵션(bullmqDedicatedRedisConnectionOptions)을 사용하여 새 인스턴스 생성
    logger.info(`[RedisClient-BullMQ] Providing new Redis connection instance for BullMQ to ${config.redis.host}:${config.redis.port} with BullMQ specific options (maxRetriesPerRequest: null).`);
    // bullmqDedicatedRedisConnectionOptions에 host, port가 이미 있으므로 new Redis(options) 사용 가능
    return new Redis(bullmqDedicatedRedisConnectionOptions);
}


module.exports = {
  getRedisClient,
  disconnectRedis,
  // redisConnectionOptions, // 이전에는 이것을 export했지만, 이제는 내부적으로 base와 bullmq 전용으로 분리됨
  getBullMQRedisConnection, // BullMQ가 사용할 함수
};
