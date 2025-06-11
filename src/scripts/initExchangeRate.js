// src/scripts/initExchangeRate.js
// 애플리케이션 시작 시 환율 정보를 초기화하는 스크립트

const exchangeRateService = require('../services/exchangeRateService');
const logger = require('../config/logger');

/**
 * 환율 정보를 초기화합니다.
 * 앱 시작 시 또는 스케줄러에서 호출됩니다.
 */
async function initializeExchangeRate() {
  logger.info('[InitExchangeRate] Starting exchange rate initialization...');
  
  try {
    // 1. 현재 캐시된 환율 정보 확인
    const cachedInfo = exchangeRateService.getCachedRateInfo();
    
    if (cachedInfo && !cachedInfo.isExpired) {
      logger.info('[InitExchangeRate] Using cached exchange rate:', {
        rate: cachedInfo.rate,
        ageMinutes: cachedInfo.ageMinutes,
        expiresInMinutes: cachedInfo.expiresInMinutes
      });
      return cachedInfo.rate;
    }
    
    // 2. 캐시가 없거나 만료된 경우 새로 가져오기
    logger.info('[InitExchangeRate] Fetching fresh exchange rate from API...');
    const rate = await exchangeRateService.refreshExchangeRate();
    
    logger.info('[InitExchangeRate] Successfully initialized exchange rate:', {
      krwToUsd: rate,
      usdToKrw: 1 / rate
    });
    
    // 3. 자동 새로고침 시작 (선택사항)
    // exchangeRateService.startAutoRefresh();
    
    return rate;
    
  } catch (error) {
    logger.error('[InitExchangeRate] Failed to initialize exchange rate:', error);
    
    // 초기화 실패 시 기본값 사용
    const fallbackRate = 0.00074; // 1 USD = 1350 KRW
    logger.warn(`[InitExchangeRate] Using fallback rate: ${fallbackRate}`);
    
    return fallbackRate;
  }
}

// 스크립트로 직접 실행할 때
if (require.main === module) {
  initializeExchangeRate()
    .then(rate => {
      logger.info('[InitExchangeRate] Exchange rate initialization completed:', rate);
      process.exit(0);
    })
    .catch(error => {
      logger.error('[InitExchangeRate] Exchange rate initialization failed:', error);
      process.exit(1);
    });
}

module.exports = initializeExchangeRate;