// src/mappers/orderMapper.js
// Shopify 주문 데이터를 번개장터 주문 생성 API가 요구하는 형식으로 변환합니다.
// 번개장터 "Create Order V2" API 명세를 기준으로 합니다.

const logger = require('../config/logger');
const { AppError, ValidationError } = require('../utils/customErrors');

/**
 * Shopify 주문의 특정 line item과 해당 번개장터 상품 상세 정보를 바탕으로
 * 번개장터 "Create Order V2" API 페이로드를 생성합니다.
 * @param {object} shopifyLineItem - 주문 처리 대상 Shopify line_item 객체.
 * @param {string} bunjangPid - 해당 상품의 번개장터 PID (숫자형 문자열).
 * @param {object} bunjangProductDetails - bunjangService.getBunjangProductDetails로 조회한 번개장터 상품 상세 정보.
 * (price, shippingFee 등 KRW 기준 정보 포함)
 * @returns {object} 번개장터 Create Order V2 API 페이로드.
 * @throws {ValidationError|AppError} 필수 데이터 누락 또는 유효하지 않은 경우.
 */
function mapShopifyItemToBunjangOrderPayload(shopifyLineItem, bunjangPid, bunjangProductDetails) {
  // 입력값 기본 검증
  if (!shopifyLineItem || !bunjangPid || !bunjangProductDetails) {
    throw new ValidationError('번개장터 주문 페이로드 매핑을 위한 필수 데이터가 누락되었습니다.', [
        { field: 'shopifyLineItem', message: !shopifyLineItem ? 'Shopify line item 누락' : undefined },
        { field: 'bunjangPid', message: !bunjangPid ? '번개장터 PID 누락' : undefined },
        { field: 'bunjangProductDetails', message: !bunjangProductDetails ? '번개장터 상품 상세 정보 누락' : undefined },
    ].filter(e => e.message));
  }

  // 번개장터 상품 상세 정보 검증
  const { price: bunjangKrwPrice, shippingFee: bunjangKrwShippingFee } = bunjangProductDetails;

  if (typeof bunjangKrwPrice === 'undefined' || typeof bunjangKrwShippingFee === 'undefined') {
    throw new AppError(`번개장터 상품(PID: ${bunjangPid}) 상세 정보에 가격 또는 배송비가 없습니다.`, 500, 'BUNJANG_PRODUCT_DATA_INCOMPLETE', true, { bunjangPid });
  }

  // 번개장터 API는 정수형 KRW를 요구함
  const currentBunjangPriceKrw = parseInt(bunjangKrwPrice, 10);
  const currentBunjangShippingFeeKrw = parseInt(bunjangKrwShippingFee, 10);

  if (isNaN(currentBunjangPriceKrw) || currentBunjangPriceKrw < 0) {
    throw new ValidationError(`번개장터 상품(PID: ${bunjangPid})의 가격이 유효하지 않습니다: ${bunjangKrwPrice}`, [{ field: 'bunjangProductDetails.price', message: '유효하지 않은 가격' }]);
  }
  if (isNaN(currentBunjangShippingFeeKrw) || currentBunjangShippingFeeKrw < 0) {
    throw new ValidationError(`번개장터 상품(PID: ${bunjangPid})의 배송비가 유효하지 않습니다: ${bunjangKrwShippingFee}`, [{ field: 'bunjangProductDetails.shippingFee', message: '유효하지 않은 배송비' }]);
  }
  
  // 최소 가격 검증 (번개장터 API 기준: 500원 이상)
  if (currentBunjangPriceKrw < 500) {
    throw new ValidationError(`번개장터 상품(PID: ${bunjangPid})의 가격이 최소 금액(500원) 미만입니다: ${currentBunjangPriceKrw}원`, [{ field: 'bunjangProductDetails.price', message: '최소 금액 미만' }]);
  }

  // 번개장터 "Create Order V2" API 페이로드:
  // { product: { id: integer, price: integer }, deliveryPrice: integer }
  const payload = {
    product: {
      id: parseInt(bunjangPid, 10),   // 번개장터 상품 ID (숫자)
      price: currentBunjangPriceKrw,   // 주문 시점의 실제 번개장터 상품 가격 (KRW, 정수)
    },
    // 요구사항: "주문 시 배송비는 자동으로 0원으로 설정되며, 배송비는 별도로 이메일을 통해 고객에게 청구됨"
    // 위 정책에 따라 deliveryPrice를 0으로 설정.
    // 실제 배송비(currentBunjangShippingFeeKrw)는 orderService에서 별도로 메타필드에 기록.
    deliveryPrice: 0,
  };

  // TODO: 번개장터 API v2에서는 배송지 정보를 받지 않는 것으로 보임.
  // 파트너 계정의 기본 배송지가 사용되거나, 주문 생성 후 별도 API로 배송지 업데이트가 필요할 수 있음.
  // 요구사항: "배송지는 서울시 금천구 디지털로 130, 남성프라자 908호(수령인: (번장)문장선 또는 (번장)씨에스트레이딩)"

  logger.debug(`[OrderMapper] Mapped Bunjang order payload for PID ${bunjangPid}:`, {
    ...payload,
    actualShippingFee: currentBunjangShippingFeeKrw, // 로깅용: 실제 배송비
  });
  
  return payload;
}

/**
 * 여러 개의 line item을 번개장터 주문 페이로드 배열로 변환합니다.
 * @param {Array} shopifyLineItems - Shopify line item 배열
 * @param {Map<string, object>} bunjangProductDetailsMap - PID를 키로 하는 번개장터 상품 상세 정보 맵
 * @returns {Array<object>} 번개장터 주문 페이로드 배열
 */
function mapMultipleItemsToBunjangOrders(shopifyLineItems, bunjangProductDetailsMap) {
  const payloads = [];
  
  for (const item of shopifyLineItems) {
    if (!item.sku || !item.sku.startsWith('BJ-')) {
      continue; // 번개장터 연동 상품이 아님
    }
    
    const bunjangPid = item.sku.substring(3);
    const bunjangProductDetails = bunjangProductDetailsMap.get(bunjangPid);
    
    if (!bunjangProductDetails) {
      logger.warn(`[OrderMapper] No product details found for PID ${bunjangPid}, skipping`);
      continue;
    }
    
    try {
      const payload = mapShopifyItemToBunjangOrderPayload(item, bunjangPid, bunjangProductDetails);
      payloads.push({
        payload,
        shopifyLineItem: item,
        bunjangPid,
      });
    } catch (error) {
      logger.error(`[OrderMapper] Failed to map item ${item.sku}: ${error.message}`);
      // 개별 아이템 매핑 실패는 전체 프로세스를 중단하지 않음
    }
  }
  
  return payloads;
}

/**
 * Shopify 주문 전체 정보에서 번개장터 관련 메타데이터를 추출합니다.
 * @param {object} shopifyOrder - Shopify 주문 객체
 * @returns {object} 번개장터 관련 메타데이터
 */
function extractBunjangMetadataFromOrder(shopifyOrder) {
  const metadata = {
    hasBunjangItems: false,
    bunjangItemCount: 0,
    bunjangPids: [],
    totalBunjangValue: 0,
  };
  
  if (!shopifyOrder || !shopifyOrder.line_items) {
    return metadata;
  }
  
  for (const item of shopifyOrder.line_items) {
    if (item.sku && item.sku.startsWith('BJ-')) {
      metadata.hasBunjangItems = true;
      metadata.bunjangItemCount++;
      metadata.bunjangPids.push(item.sku.substring(3));
      metadata.totalBunjangValue += (parseFloat(item.price) || 0) * (item.quantity || 1);
    }
  }
  
  return metadata;
}

module.exports = {
  mapShopifyItemToBunjangOrderPayload,
  mapMultipleItemsToBunjangOrders,
  extractBunjangMetadataFromOrder,
};