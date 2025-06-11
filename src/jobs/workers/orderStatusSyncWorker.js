// src/jobs/workers/orderStatusSyncWorker.js
// 번개장터 주문 상태를 주기적으로 동기화하는 워커

const { Worker } = require('bullmq');
const config = require('../../config');
const logger = require('../../config/logger');
const orderService = require('../../services/orderService');
const redisConnection = require('../../config/redisClient');

const QUEUE_NAME = config.bullmq.queues.orderStatusSync || 'order-status-sync-queue';

/**
 * 주문 상태 동기화 작업을 처리하는 워커
 */
const orderStatusSyncWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { startDate, endDate } = job.data;
    const jobId = job.id;
    
    logger.info(`[OrderStatusSyncWorker:Job-${jobId}] Starting order status sync job`, {
      startDate,
      endDate,
    });
    
    try {
      // 날짜 범위가 없으면 기본값 설정 (최근 24시간)
      const syncEndDate = endDate || new Date();
      const syncStartDate = startDate || new Date(syncEndDate.getTime() - 24 * 60 * 60 * 1000);
      
      // 주문 상태 동기화 실행
      const result = await orderService.syncBunjangOrderStatuses(
        syncStartDate,
        syncEndDate,
        jobId
      );
      
      logger.info(`[OrderStatusSyncWorker:Job-${jobId}] Order status sync completed`, result);
      
      return result;
      
    } catch (error) {
      logger.error(`[OrderStatusSyncWorker:Job-${jobId}] Order status sync failed`, {
        error: error.message,
        stack: error.stack,
      });
      
      // 에러를 다시 throw하여 BullMQ가 재시도하도록 함
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // 동시에 하나의 작업만 처리
    removeOnComplete: {
      age: 24 * 3600, // 24시간 후 완료된 작업 제거
      count: 100, // 최대 100개의 완료된 작업 유지
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // 7일 후 실패한 작업 제거
    },
  }
);

// 워커 이벤트 핸들러
orderStatusSyncWorker.on('completed', (job, result) => {
  logger.info(`[OrderStatusSyncWorker] Job ${job.id} completed successfully`, {
    syncedOrders: result.syncedOrders,
    errors: result.errors,
  });
});

orderStatusSyncWorker.on('failed', (job, err) => {
  logger.error(`[OrderStatusSyncWorker] Job ${job.id} failed`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

orderStatusSyncWorker.on('error', (err) => {
  logger.error('[OrderStatusSyncWorker] Worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[OrderStatusSyncWorker] Received SIGTERM, closing worker...');
  await orderStatusSyncWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('[OrderStatusSyncWorker] Received SIGINT, closing worker...');
  await orderStatusSyncWorker.close();
  process.exit(0);
});

logger.info('[OrderStatusSyncWorker] Order status sync worker started');

module.exports = orderStatusSyncWorker;