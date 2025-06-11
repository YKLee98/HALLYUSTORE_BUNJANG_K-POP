// src/config/database.js
// MongoDB (Mongoose) 연결 설정

const mongoose = require('mongoose');
const config =require('./index'); // 통합 설정 로더
const logger = require('./logger'); // Winston 로거

let connectionAttempt = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000; // 5초

const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) { // 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
    logger.info('MongoDB is already connected.');
    return;
  }

  connectionAttempt++;
  logger.info(`Attempting MongoDB connection (Attempt ${connectionAttempt}/${MAX_CONNECTION_ATTEMPTS})... URI: ${config.database.connectionString.replace(/:[^:]+@/, ':<password_hidden>@')}`);

  try {
    if (!config.database.connectionString) {
      logger.error('MongoDB connection string is missing in configuration (DB_CONNECTION_STRING). Application cannot start.');
      process.exit(1); // 필수 설정이 없으면 애플리케이션 종료
    }

    // Mongoose 연결 옵션 (최신 버전에서는 대부분 자동 설정됨)
    const mongooseOptions = {
      ...config.database.options, // config/index.js 에서 정의된 옵션
      // bufferCommands: false, // 연결 전까지 명령 버퍼링 비활성화 (빠른 실패 유도 시)
      // serverSelectionTimeoutMS: 5000, // 이미 config.database.options 에 포함 가능
    };

    await mongoose.connect(config.database.connectionString, mongooseOptions);

    logger.info('MongoDB connected successfully.');
    connectionAttempt = 0; // 성공 시 재시도 횟수 초기화

    // 연결 이벤트 리스너 설정
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error after initial successful connection:', err);
      // 여기서 애플리케이션을 종료할지, 아니면 재연결을 계속 시도할지 결정 필요
      // Mongoose는 특정 상황에서 자동 재연결을 시도할 수 있음
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting to reconnect if appropriate...');
      // 여기서 수동 재연결 로직을 넣거나, Mongoose의 자동 재연결에 의존.
      // 또는 애플리케이션 상태를 unhealthy로 변경.
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected successfully.');
    });

    // SIGINT, SIGTERM 등 프로세스 종료 신호 처리 시 mongoose.disconnect() 호출 (index.js의 gracefulShutdown에서)

  } catch (error) {
    logger.error(`MongoDB connection failed (Attempt ${connectionAttempt}):`, error);
    if (connectionAttempt < MAX_CONNECTION_ATTEMPTS) {
      logger.info(`Retrying MongoDB connection in ${RETRY_DELAY_MS / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return connectDB(); // 재귀 호출로 재시도
    } else {
      logger.error(`Failed to connect to MongoDB after ${MAX_CONNECTION_ATTEMPTS} attempts. Application will exit.`);
      process.exit(1); // 최대 재시도 후에도 연결 실패 시 프로세스 종료
    }
  }
};

// Mongoose 연결 해제 함수 (graceful shutdown 시 사용)
const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) { // 0: disconnected
    try {
      await mongoose.disconnect();
      logger.info('MongoDB disconnected successfully through disconnectDB function.');
    } catch (error) {
      logger.error('Error disconnecting MongoDB:', error);
    }
  } else {
    logger.info('MongoDB was already disconnected.');
  }
};


module.exports = {
    connectDB,
    disconnectDB,
};
