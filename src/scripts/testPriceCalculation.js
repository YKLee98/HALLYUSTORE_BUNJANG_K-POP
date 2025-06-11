// src/scripts/testPriceCalculation.js
// 가격 계산 프로세스를 테스트하는 스크립트

const config = require('../config');
const logger = require('../config/logger');
const exchangeRateService = require('../services/exchangeRateService');
const { calculateShopifyPriceUsd } = require('../services/priceCalculationService');

async function runPriceCalculationTest() {
  console.log('\n========================================');
  console.log('번개장터 → Shopify 가격 계산 테스트');
  console.log('========================================\n');
  
  // 1. 환경 변수 확인
  console.log('1. 환경 변수 확인:');
  console.log('-------------------');
  console.log(`OPENEXCHANGERATES_APP_ID: ${process.env.OPENEXCHANGERATES_APP_ID ? '✅ 설정됨' : '❌ 없음'}`);
  console.log(`PRICE_MARKUP_PERCENTAGE: ${config.priceCalculation.markupPercentage}%`);
  console.log(`HANDLING_FEE_USD: $${config.priceCalculation.handlingFeeUsd}`);
  console.log();
  
  // 2. 환율 서비스 테스트
  console.log('2. 환율 서비스 테스트:');
  console.log('---------------------');
  
  try {
    // 캐시된 환율 정보 확인
    const cachedInfo = exchangeRateService.getCachedRateInfo();
    if (cachedInfo) {
      console.log('캐시된 환율 정보:');
      console.log(`  - 환율: 1 KRW = ${cachedInfo.rate.toFixed(8)} USD`);
      console.log(`  - 캐시 나이: ${cachedInfo.ageMinutes}분`);
      console.log(`  - 만료 여부: ${cachedInfo.isExpired ? '만료됨' : '유효함'}`);
    } else {
      console.log('캐시된 환율 정보 없음');
    }
    
    // 새로운 환율 가져오기
    console.log('\n새로운 환율 가져오기...');
    const freshRate = await exchangeRateService.getKrwToUsdRate();
    console.log(`✅ 현재 환율: 1 KRW = ${freshRate.toFixed(8)} USD`);
    console.log(`  (1 USD = ${(1/freshRate).toFixed(2)} KRW)`);
    
  } catch (error) {
    console.error('❌ 환율 가져오기 실패:', error.message);
    console.log('Fallback 환율 사용: 1 KRW = 0.00074 USD');
  }
  
  // 3. 가격 계산 테스트
  console.log('\n3. 가격 계산 테스트:');
  console.log('-------------------');
  
  const testPrices = [1000, 5000, 10000, 50000, 100000, 500000];
  
  for (const krwPrice of testPrices) {
    try {
      const usdPrice = await calculateShopifyPriceUsd(krwPrice);
      console.log(`✅ ${krwPrice.toLocaleString()} KRW → $${usdPrice} USD`);
    } catch (error) {
      console.error(`❌ ${krwPrice} KRW 계산 실패:`, error.message);
    }
  }
  
  // 4. 상세 계산 예시
  console.log('\n4. 상세 계산 예시 (50,000원 상품):');
  console.log('--------------------------------');
  
  try {
    const testPrice = 50000;
    const rate = await exchangeRateService.getKrwToUsdRate();
    const markupPercent = config.priceCalculation.markupPercentage;
    const handlingFee = config.priceCalculation.handlingFeeUsd;
    
    const step1 = testPrice * rate;
    const step2 = step1 * (1 + markupPercent/100);
    const finalPrice = step2 + handlingFee;
    
    console.log(`원가: ${testPrice.toLocaleString()} KRW`);
    console.log(`환율: 1 KRW = ${rate.toFixed(8)} USD`);
    console.log(`Step 1 - USD 변환: ${testPrice} × ${rate.toFixed(8)} = $${step1.toFixed(4)}`);
    console.log(`Step 2 - 마크업 (${markupPercent}%): $${step1.toFixed(4)} × 1.${markupPercent} = $${step2.toFixed(4)}`);
    console.log(`Step 3 - 취급수수료: $${step2.toFixed(4)} + $${handlingFee} = $${finalPrice.toFixed(2)}`);
    console.log(`\n최종 가격: $${finalPrice.toFixed(2)}`);
    
  } catch (error) {
    console.error('상세 계산 실패:', error.message);
  }
  
  console.log('\n========================================\n');
}

// 스크립트 실행
if (require.main === module) {
  runPriceCalculationTest()
    .then(() => {
      console.log('테스트 완료');
      process.exit(0);
    })
    .catch(error => {
      console.error('테스트 실패:', error);
      process.exit(1);
    });
}

module.exports = runPriceCalculationTest;