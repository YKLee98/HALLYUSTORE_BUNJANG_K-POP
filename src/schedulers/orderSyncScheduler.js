// src/schedulers/orderSyncScheduler.js
// 번개장터 주문 상태 동기화를 주기적으로 실행하는 스케줄러

const { Queue } = require('bullmq');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../config/logger');
const redisConnection = require('../config/redisClient');

const ORDER_STATUS_SYNC_QUEUE = 'orderStatusSync';

// 주문 상태 동기화 큐
const orderStatusSyncQueue = new Queue(ORDER_STATUS_SYNC_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5초부터 시작
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

/**
 * 주문 상태 동기화 작업을 큐에 추가
 * @param {object} options - 동기화 옵션
 * @param {Date} [options.startDate] - 조회 시작일
 * @param {Date} [options.endDate] - 조회 종료일
 * @param {boolean} [options.immediate=false] - 즉시 실행 여부
 */
async function scheduleOrderStatusSync(options = {}) {
  try {
    const { startDate, endDate, immediate = false } = options;
    
    const jobData = {
      startDate: startDate || new Date(Date.now() - 24 * 60 * 60 * 1000), // 기본: 24시간 전
      endDate: endDate || new Date(), // 기본: 현재 시간
      scheduledAt: new Date(),
    };
    
    // 날짜 범위 검증 (최대 15일)
    const diffDays = (jobData.endDate - jobData.startDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 15) {
      logger.error('[OrderSyncScheduler] Date range exceeds 15 days limit', {
        startDate: jobData.startDate,
        endDate: jobData.endDate,
        diffDays,
      });
      return null;
    }
    
    const job = await orderStatusSyncQueue.add(
      'syncOrderStatuses',
      jobData,
      {
        delay: immediate ? 0 : 60000, // 즉시 실행하거나 1분 후 실행
      }
    );
    
    logger.info('[OrderSyncScheduler] Order status sync job scheduled', {
      jobId: job.id,
      startDate: jobData.startDate,
      endDate: jobData.endDate,
      immediate,
    });
    
    return job;
    
  } catch (error) {
    logger.error('[OrderSyncScheduler] Failed to schedule order status sync', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * 크론 작업 초기화
 */
function initializeCronJobs() {
  // 매 시간 정각에 실행 (최근 2시간의 주문 상태 동기화)
  cron.schedule('0 * * * *', async () => {
    logger.info('[OrderSyncScheduler] Hourly order status sync triggered');
    try {
      await scheduleOrderStatusSync({
        startDate: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2시간 전
        endDate: new Date(),
        immediate: true,
      });
    } catch (error) {
      logger.error('[OrderSyncScheduler] Hourly sync scheduling failed', error);
    }
  });
  
  // 매일 오전 2시에 전일 주문 전체 동기화
  cron.schedule('0 2 * * *', async () => {
    logger.info('[OrderSyncScheduler] Daily order status sync triggered');
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      await scheduleOrderStatusSync({
        startDate: yesterday,
        endDate: today,
        immediate: true,
      });
    } catch (error) {
      logger.error('[OrderSyncScheduler] Daily sync scheduling failed', error);
    }
  });
  
  // 매 30분마다 최근 1시간 주문 동기화 (선택사항 - 더 빈번한 동기화가 필요한 경우)
  if (config.bunjang.enableFrequentSync === 'true') {
    cron.schedule('*/30 * * * *', async () => {
      logger.info('[OrderSyncScheduler] 30-minute order status sync triggered');
      try {
        await scheduleOrderStatusSync({
          startDate: new Date(Date.now() - 60 * 60 * 1000), // 1시간 전
          endDate: new Date(),
          immediate: true,
        });
      } catch (error) {
        logger.error('[OrderSyncScheduler] 30-minute sync scheduling failed', error);
      }
    });
  }
  
  logger.info('[OrderSyncScheduler] Cron jobs initialized');
}

/**
 * 수동으로 특정 기간의 주문 동기화 실행
 * @param {string} startDate - 시작일 (ISO 형식)
 * @param {string} endDate - 종료일 (ISO 형식)
 */
async function manualOrderSync(startDate, endDate) {
  logger.info('[OrderSyncScheduler] Manual order sync requested', { startDate, endDate });
  
  try {
    const job = await scheduleOrderStatusSync({
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      immediate: true,
    });
    
    return {
      success: true,
      jobId: job.id,
      message: `주문 동기화 작업이 예약되었습니다. Job ID: ${job.id}`,
    };
  } catch (error) {
    logger.error('[OrderSyncScheduler] Manual sync failed', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// 환경 변수로 스케줄러 활성화 여부 제어
if (process.env.ENABLE_ORDER_SYNC_SCHEDULER !== 'false') {
  initializeCronJobs();
  logger.info('[OrderSyncScheduler] Order sync scheduler started');
} else {
  logger.info('[OrderSyncScheduler] Order sync scheduler is disabled');
}

module.exports = {
  scheduleOrderStatusSync,
  orderStatusSyncQueue,
  manualOrderSync,
};