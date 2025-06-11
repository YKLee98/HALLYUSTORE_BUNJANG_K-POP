// src/config/logger.js
// Winston 로깅 라이브러리 설정. 로그 레벨, 포맷, 전송 매체(콘솔, 파일 등) 정의.

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
// config/index.js가 dotenv를 먼저 호출하므로, 여기서는 config 객체를 직접 사용하지 않고 process.env를 사용하거나,
// config 객체를 인자로 받아 사용하도록 수정 가능. 여기서는 process.env를 직접 참조.
// 또는, 이 파일이 config/index.js 이후에 로드되도록 순서 조정. (index.js에서 logger를 config 이후에 require)

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const logDir = path.resolve(__dirname, process.env.LOG_DIR || '../../logs');
const logFileBaseName = process.env.LOG_FILE_BASE_NAME || (process.env.APP_NAME || 'app');
const maxFileSize = process.env.LOG_MAX_SIZE || '20m';
const maxFiles = process.env.NODE_ENV === 'production' ? (process.env.LOG_MAX_FILES_PROD || '30d') : (process.env.LOG_MAX_FILES_DEV || '7d');
const handleExceptions = process.env.LOG_HANDLE_EXCEPTIONS !== 'false'; // 기본 true
const handleRejections = process.env.LOG_HANDLE_REJECTIONS !== 'false'; // 기본 true

// 로그 디렉토리 없으면 생성
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    console.error(`Failed to create log directory at ${logDir}:`, e);
    // 로그 디렉토리 생성 실패 시 파일 로깅은 불가능하므로 콘솔 로깅만 사용될 수 있음.
  }
}

// 에러 객체를 로깅 가능한 형태로 변환하는 포맷터
const errorFormatter = winston.format(info => {
  if (info.message instanceof Error) {
    // Error 객체의 message와 stack을 info 객체에 직접 할당
    // info.message는 이미 Error 객체의 message일 수 있으므로, info.originalMessage 등으로 보존 가능
    return { ...info, message: info.message.message, stack: info.message.stack, errorCode: info.message.errorCode, details: info.message.details };
  }
  if (info instanceof Error) {
    return { ...info, message: info.message, stack: info.stack, errorCode: info.errorCode, details: info.details };
  }
  return info;
});

// 로그 포맷 정의
const baseFormat = [
  errorFormatter(), // 에러 객체 처리 포맷터 먼저 적용
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS ZZ' }), // 타임스탬프 (타임존 포함)
  winston.format.splat(), // '%s %d' 같은 형식 지원
  // winston.format.json(), // JSON 형식으로 로그 전체를 감싸는 대신, printf에서 커스텀
];

// 콘솔 출력용 포맷 (색상 적용)
const consoleFormat = winston.format.combine(
  ...baseFormat,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, service, errorCode, details, ...metadata }) => {
    let log = `${timestamp} [${level}]`;
    if (service) log += ` [${service}]`;
    if (errorCode) log += ` (${errorCode})`;
    log += `: ${message}`;

    // details 객체가 있으면 예쁘게 출력
    if (details && Object.keys(details).length > 0) {
        try { log += `\nDetails: ${JSON.stringify(details, null, 2)}`; } catch (e) { log += `\nDetails: (Unserializable)`;}
    }
    // 나머지 메타데이터 (필요시)
    const remainingMeta = Object.keys(metadata).filter(key => !['label', 'message', 'level', 'timestamp', 'stack', 'service', 'errorCode', 'details'].includes(key));
    if (remainingMeta.length > 0) {
        try { log += `\nMetadata: ${JSON.stringify(Object.fromEntries(remainingMeta.map(k => [k, metadata[k]])), null, 2)}`; } catch(e) { log += `\nMetadata: (Unserializable)`; }
    }
    if (stack) log += `\nStack: ${stack}`;
    return log;
  })
);

// 파일 저장용 포맷 (JSON 또는 텍스트)
const fileFormat = winston.format.combine(
  ...baseFormat,
  // winston.format.json() // 파일 로그는 JSON 형식이 분석에 용이
  winston.format.printf(({ timestamp, level, message, stack, service, errorCode, details, ...metadata }) => {
    // JSON으로 저장할 객체 구성
    const logObject = {
        timestamp,
        level,
        message,
        ...(service && { service }),
        ...(errorCode && { errorCode }),
        ...(details && Object.keys(details).length > 0 && { details }),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined, // 불필요한 빈 객체 제외
        ...(stack && { stack }),
    };
    return JSON.stringify(logObject);
  })
);

const transports = [
  new winston.transports.Console({
    level: logLevel,
    format: consoleFormat,
    handleExceptions: handleExceptions,
    handleRejections: handleRejections,
  }),
];

// 파일 로깅은 로그 디렉토리가 정상적으로 접근 가능할 때만 추가
if (fs.existsSync(logDir) && fs.lstatSync(logDir).isDirectory()) {
  transports.push(
    new DailyRotateFile({
      level: logLevel, // 모든 레벨 기록
      dirname: logDir,
      filename: `${logFileBaseName}-%DATE%-combined.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: maxFileSize,
      maxFiles: maxFiles,
      format: fileFormat,
      handleExceptions: handleExceptions,
      handleRejections: handleRejections,
    }),
    new DailyRotateFile({ // 에러 레벨만 별도 파일로 (선택 사항)
      level: 'error',
      dirname: logDir,
      filename: `${logFileBaseName}-%DATE%-error.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: maxFileSize,
      maxFiles: maxFiles, // 에러 로그는 더 오래 보관 가능
      format: fileFormat, // 동일 포맷 사용
      handleExceptions: handleExceptions, // 에러 파일에도 예외 로깅
      handleRejections: handleRejections,
    })
  );
} else {
  console.warn(`Log directory ${logDir} is not accessible. File logging will be disabled.`);
}

// Winston 로거 인스턴스 생성
const logger = winston.createLogger({
  level: logLevel, // 전역 로그 레벨 (각 transport에서 오버라이드 가능)
  // format: fileFormat, // 기본 포맷 (transport에서 개별 지정 시 불필요)
  defaultMeta: { service: process.env.APP_NAME || 'bunjang-shopify-sync' }, // 모든 로그에 기본 메타데이터
  transports: transports,
  exitOnError: false, // 처리되지 않은 예외 발생 시 프로세스 종료 안 함 (graceful shutdown에서 처리)
});

// Morgan HTTP 요청 로깅을 위한 스트림 인터페이스
logger.stream = {
  write: (message) => {
    // Morgan 로그는 보통 info 또는 http 레벨로 기록
    logger.http(message.trim());
  },
};

// 애플리케이션 시작 시 로거 설정 정보 출력 (디버깅용)
// logger.debug('Logger initialized with settings:', { logLevel, logDir, logFileBaseName, transportsCount: transports.length });

module.exports = logger;
