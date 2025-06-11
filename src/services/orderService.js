// src/services/orderService.js
// Shopify 주문 웹훅 수신 후 번개장터 주문 생성 등의 로직을 담당합니다.

const config = require('../config');
const logger = require('../config/logger');
const bunjangService = require('./bunjangService');
const shopifyService = require('./shopifyService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ExternalServiceError, NotFoundError, ValidationError } = require('../utils/customErrors');

/**
 * Shopify 주문 데이터를 기반으로 번개장터에 주문을 생성합니다.
 * @param {object} shopifyOrder - Shopify 주문 객체 (웹훅 페이로드 또는 DB에서 가져온 객체).
 * @param {string} [jobId='N/A'] - 호출한 BullMQ 작업 ID (로깅용).
 * @returns {Promise<{success: boolean, bunjangOrderIds?: array, message?: string}>} 처리 결과.
 */
async function processShopifyOrderForBunjang(shopifyOrder, jobId = 'N/A') {
  const shopifyOrderId = shopifyOrder.id; // Shopify REST API ID
  const shopifyOrderGid = shopifyOrder.admin_graphql_api_id; // Shopify GraphQL GID
  logger.info(`[OrderSvc:Job-${jobId}] Processing Shopify Order ID: ${shopifyOrderId} (GID: ${shopifyOrderGid}) for Bunjang.`);

  // Shopify 주문 객체 유효성 검사
  if (!shopifyOrder || !shopifyOrderId || !shopifyOrderGid || !Array.isArray(shopifyOrder.line_items) || shopifyOrder.line_items.length === 0) {
    throw new ValidationError('유효하지 않은 Shopify 주문 데이터입니다. (ID 또는 line_items 누락)', [{field: 'shopifyOrder', message: 'Order data invalid or missing line items.'}]);
  }

  const bunjangOrderIdentifier = `${config.bunjang.orderIdentifierPrefix || 'BunjangOrder-'}${shopifyOrderId}`;
  let bunjangOrderSuccessfullyCreatedOverall = false;
  let createdBunjangOrderIds = [];

  // 이미 처리된 주문인지 확인 (중복 방지)
  try {
    const existingMetafield = await shopifyService.getOrderMetafield(shopifyOrderGid, "bunjang", "order_ids");
    if (existingMetafield && existingMetafield.value) {
      logger.info(`[OrderSvc:Job-${jobId}] Bunjang order already exists for Shopify Order ${shopifyOrderId}. Skipping.`);
      return { success: true, alreadyProcessed: true, bunjangOrderIds: JSON.parse(existingMetafield.value) };
    }
  } catch (error) {
    logger.warn(`[OrderSvc:Job-${jobId}] Could not check existing order metadata: ${error.message}`);
  }

  // Shopify 주문의 각 line item을 순회
  for (const item of shopifyOrder.line_items) {
    const productId = item.product_id;
    
    // 1. 먼저 DB에서 확인
    let syncedProduct = await SyncedProduct.findOne({
      $or: [
        { shopifyGid: `gid://shopify/Product/${productId}` },
        { 'shopifyData.id': productId },
        { 'shopifyData.id': String(productId) }
      ]
    }).lean();
    
    // 2. DB에 없으면 Shopify에서 태그 확인하여 자동 연결
    if (!syncedProduct) {
      logger.info(`[OrderSvc:Job-${jobId}] Product not in DB, checking Shopify tags for product ${productId}`);
      
      const productQuery = `
        query getProductTags($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            tags
          }
        }
      `;
      
      try {
        const productGid = `gid://shopify/Product/${productId}`;
        const productResponse = await shopifyService.shopifyGraphqlRequest(productQuery, { id: productGid });
        const product = productResponse.data?.product;
        
        if (product) {
          const bunjangPidTag = product.tags.find(tag => tag.startsWith('bunjang_pid:'));
          
          if (bunjangPidTag) {
            const bunjangPid = bunjangPidTag.split(':')[1].trim();
            
            // DB에 저장
            syncedProduct = await SyncedProduct.create({
              shopifyGid: product.id,
              shopifyData: {
                id: productId,
                title: product.title,
                handle: product.handle
              },
              bunjangPid: String(bunjangPid),
              bunjangProductName: product.title,
              syncStatus: 'SYNCED',
              lastSyncedAt: new Date()
            });
            
            logger.info(`[OrderSvc:Job-${jobId}] Auto-synced product from tags: ${product.title} (Bunjang PID: ${bunjangPid})`);
          }
        }
      } catch (error) {
        logger.error(`[OrderSvc:Job-${jobId}] Error fetching product tags: ${error.message}`);
      }
    }
    
    if (!syncedProduct || !syncedProduct.bunjangPid) {
      logger.debug(`[OrderSvc:Job-${jobId}] Shopify product ${productId} is not linked to Bunjang. Skipping.`);
      continue;
    }

    const bunjangPid = syncedProduct.bunjangPid;
    logger.info(`[OrderSvc:Job-${jobId}] Found Bunjang-linked item: Shopify Product ${productId} -> Bunjang PID ${bunjangPid}`);

    try {
      // 3. 주문 시점의 번개장터 상품 최신 정보 조회
      const bunjangProductDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
      
      if (!bunjangProductDetails) {
        logger.warn(`[OrderSvc:Job-${jobId}] Could not fetch details for Bunjang product PID ${bunjangPid}`);
        await shopifyService.updateOrder({ 
          id: shopifyOrderGid, 
          tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NotFound`] 
        });
        continue;
      }

      // 4. 재고 확인
      const availableQuantity = bunjangProductDetails.quantity || 0;
      if (availableQuantity < item.quantity) {
        logger.warn(`[OrderSvc:Job-${jobId}] Insufficient stock for PID ${bunjangPid}. Available: ${availableQuantity}, Requested: ${item.quantity}`);
        await shopifyService.updateOrder({ 
          id: shopifyOrderGid, 
          tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-InsufficientStock`] 
        });
        continue;
      }

      // 5. 번개장터 주문 페이로드 생성
      const bunjangOrderPayload = {
        product: {
          id: parseInt(bunjangPid),
          price: bunjangProductDetails.price || 0
        },
        deliveryPrice: 0 // 배송비 0원 정책 적용
      };
      
      const actualBunjangShippingFeeKrw = bunjangProductDetails.shippingFee || 0;
      logger.info(`[OrderSvc:Job-${jobId}] Creating Bunjang order for PID ${bunjangPid}. Price: ${bunjangOrderPayload.product.price} KRW, Actual shipping: ${actualBunjangShippingFeeKrw} KRW (applied as 0)`);

      // 6. 번개장터 주문 생성 API 호출
      try {
        const bunjangApiResponse = await bunjangService.createBunjangOrderV2(bunjangOrderPayload);
        
        if (bunjangApiResponse && bunjangApiResponse.id) {
          const bunjangOrderId = bunjangApiResponse.id;
          logger.info(`[OrderSvc:Job-${jobId}] ✅ Successfully created Bunjang order for PID ${bunjangPid}. Bunjang Order ID: ${bunjangOrderId}`);
          createdBunjangOrderIds.push(String(bunjangOrderId));
          bunjangOrderSuccessfullyCreatedOverall = true;

          // 7. Shopify 주문에 태그 추가 (개별 성공)
          const tagsToAdd = [`BunjangOrder-${bunjangOrderId}`];
          await shopifyService.updateOrder({ id: shopifyOrderGid, tags: tagsToAdd });
          
          // 8. 포인트 잔액 확인
          try {
            const pointBalance = await bunjangService.getBunjangPointBalance();
            if (pointBalance) {
              logger.info(`[OrderSvc:Job-${jobId}] Current Bunjang point balance: ${pointBalance.balance} KRW`);
              
              const LOW_BALANCE_THRESHOLD = config.bunjang.lowBalanceThreshold || 1000000;
              if (pointBalance.balance < LOW_BALANCE_THRESHOLD) {
                logger.warn(`[OrderSvc:Job-${jobId}] ⚠️ LOW POINT BALANCE WARNING: ${pointBalance.balance} KRW < ${LOW_BALANCE_THRESHOLD} KRW`);
                await shopifyService.updateOrder({ 
                  id: shopifyOrderGid, 
                  tags: [`LowPointBalance`] 
                });
              }
            }
          } catch (balanceError) {
            logger.warn(`[OrderSvc:Job-${jobId}] Failed to check point balance: ${balanceError.message}`);
          }
        } else {
          logger.error(`[OrderSvc:Job-${jobId}] Bunjang order creation response missing order ID for PID ${bunjangPid}`);
          await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NoOrderId`] });
        }
      } catch (apiError) {
        // 번개장터 API 에러 처리
        let errorTag = `PID-${bunjangPid}-CreateFail`;
        let errorMessage = apiError.message;
        
        if (apiError.originalError?.response?.data?.errorCode) {
          const errorCode = apiError.originalError.response.data.errorCode;
          errorMessage = `${errorCode}: ${apiError.originalError.response.data.reason || apiError.message}`;
          
          switch(errorCode) {
            case 'PRODUCT_NOT_FOUND':
            case 'PRODUCT_SOLD_OUT':
            case 'PRODUCT_ON_HOLD':
              errorTag = `PID-${bunjangPid}-NotAvailable`;
              break;
            case 'INVALID_PRODUCT_PRICE':
              errorTag = `PID-${bunjangPid}-PriceChanged`;
              break;
            case 'POINT_SHORTAGE':
              errorTag = `PID-${bunjangPid}-InsufficientPoints`;
              logger.error(`[OrderSvc:Job-${jobId}] ❌ CRITICAL: Insufficient Bunjang points`);
              break;
          }
        }
        
        logger.error(`[OrderSvc:Job-${jobId}] Failed to create Bunjang order for PID ${bunjangPid}: ${errorMessage}`);
        await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, errorTag] });
      }

    } catch (error) {
      logger.error(`[OrderSvc:Job-${jobId}] Error processing Bunjang order for PID ${bunjangPid}: ${error.message}`);
      await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-Exception`] });
    }
  }

  // 주문 처리 완료 후 메타필드 업데이트
  if (createdBunjangOrderIds.length > 0) {
    const metafieldsInput = [
      { 
        namespace: "bunjang", 
        key: "order_ids", 
        value: JSON.stringify(createdBunjangOrderIds), 
        type: "json" 
      },
      { 
        namespace: "bunjang", 
        key: "order_created_at", 
        value: new Date().toISOString(), 
        type: "date_time" 
      }
    ];
    
    await shopifyService.updateOrder({ 
      id: shopifyOrderGid, 
      tags: ['BunjangOrderPlaced', bunjangOrderIdentifier],
      metafields: metafieldsInput 
    });
  }

  if (bunjangOrderSuccessfullyCreatedOverall) {
    logger.info(`[OrderSvc:Job-${jobId}] ✅ Bunjang order(s) successfully created for Shopify Order ${shopifyOrderId}: ${createdBunjangOrderIds.join(', ')}`);
    return { success: true, bunjangOrderIds: createdBunjangOrderIds };
  } else {
    logger.warn(`[OrderSvc:Job-${jobId}] ❌ No Bunjang orders created for Shopify Order ${shopifyOrderId}`);
    return { success: false, message: '번개장터 주문 생성 실패' };
  }
}

/**
 * 번개장터 주문 상태를 동기화합니다.
 * @param {Date|string} startDate - 조회 시작일
 * @param {Date|string} endDate - 조회 종료일 (최대 15일 간격)
 * @param {string} [jobId='N/A'] - 작업 ID (로깅용)
 * @returns {Promise<{success: boolean, syncedOrders: number, errors: number}>}
 */
async function syncBunjangOrderStatuses(startDate, endDate, jobId = 'N/A') {
  logger.info(`[OrderSvc:Job-${jobId}] Starting Bunjang order status sync from ${startDate} to ${endDate}`);
  
  // 날짜 포맷 변환 (UTC ISO 형식으로)
  const startDateUTC = new Date(startDate).toISOString();
  const endDateUTC = new Date(endDate).toISOString();
  
  // 날짜 범위 검증 (최대 15일)
  const diffDays = (new Date(endDateUTC) - new Date(startDateUTC)) / (1000 * 60 * 60 * 24);
  if (diffDays > 15) {
    throw new ValidationError('번개장터 주문 조회는 최대 15일 범위만 가능합니다.', [
      { field: 'dateRange', message: `요청된 범위: ${diffDays}일` }
    ]);
  }
  
  let syncedCount = 0;
  let errorCount = 0;
  let page = 0;
  let hasMore = true;
  
  try {
    while (hasMore) {
      const ordersResponse = await bunjangService.getBunjangOrders({
        statusUpdateStartDate: startDateUTC,
        statusUpdateEndDate: endDateUTC,
        page: page,
        size: 100 // 최대값 사용
      });
      
      if (!ordersResponse || !ordersResponse.data) break;
      
      for (const order of ordersResponse.data) {
        try {
          await updateShopifyOrderFromBunjangStatus(order, jobId);
          syncedCount++;
        } catch (error) {
          logger.error(`[OrderSvc:Job-${jobId}] Failed to sync order ${order.id}: ${error.message}`);
          errorCount++;
        }
      }
      
      hasMore = page < (ordersResponse.totalPages - 1);
      page++;
    }
    
    logger.info(`[OrderSvc:Job-${jobId}] Order status sync completed. Synced: ${syncedCount}, Errors: ${errorCount}`);
    return { success: true, syncedOrders: syncedCount, errors: errorCount };
    
  } catch (error) {
    logger.error(`[OrderSvc:Job-${jobId}] Order status sync failed: ${error.message}`);
    throw error;
  }
}

/**
 * 번개장터 주문 상태를 기반으로 Shopify 주문을 업데이트합니다.
 * @param {object} bunjangOrder - 번개장터 주문 정보
 * @param {string} [jobId='N/A'] - 작업 ID
 */
async function updateShopifyOrderFromBunjangStatus(bunjangOrder, jobId = 'N/A') {
  const bunjangOrderId = bunjangOrder.id;
  
  // Shopify에서 해당 번개장터 주문과 연결된 주문 찾기
  const query = `
    query findOrderByBunjangId($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            tags
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }
        }
      }
    }
  `;
  
  const searchQuery = `tag:"BunjangOrder-${bunjangOrderId}"`;
  const response = await shopifyService.shopifyGraphqlRequest(query, { query: searchQuery });
  
  if (!response.data.orders.edges || response.data.orders.edges.length === 0) {
    logger.warn(`[OrderSvc:Job-${jobId}] No Shopify order found for Bunjang order ${bunjangOrderId}`);
    return;
  }
  
  const shopifyOrder = response.data.orders.edges[0].node;
  const shopifyOrderGid = shopifyOrder.id;
  
  // 각 주문 아이템의 상태 확인
  for (const orderItem of bunjangOrder.orderItems) {
    const status = orderItem.status;
    const productId = orderItem.product.id;
    
    logger.info(`[OrderSvc:Job-${jobId}] Bunjang order ${bunjangOrderId}, product ${productId} status: ${status}`);
    
    // 상태별 처리
    switch(status) {
      case 'SHIP_READY':
      case 'IN_TRANSIT':
      case 'DELIVERY_COMPLETED':
        // 배송 관련 상태 - Shopify fulfillment 업데이트 필요
        await updateShopifyFulfillmentStatus(shopifyOrderGid, status, orderItem, jobId);
        break;
        
      case 'PURCHASE_CONFIRM':
        // 구매 확정 - 메타필드 업데이트
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          metafields: [{
            namespace: 'bunjang',
            key: 'purchase_confirmed',
            value: 'true',
            type: 'single_line_text_field'
          }, {
            namespace: 'bunjang',
            key: 'purchase_confirmed_at',
            value: orderItem.purchaseConfirmedAt || new Date().toISOString(),
            type: 'date_time'
          }]
        });
        break;
        
      case 'CANCEL_REQUESTED_BEFORE_SHIPPING':
      case 'REFUNDED':
      case 'RETURN_REQUESTED':
      case 'RETURNED':
        // 취소/반품 관련 - 태그 추가
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          tags: [`BunjangStatus-${status}`, `BunjangOrder-${bunjangOrderId}-${status}`]
        });
        // TODO: Shopify 환불 처리 로직 추가 필요
        break;
    }
    
    // 상태 업데이트 시간 기록
    await shopifyService.updateOrder({
      id: shopifyOrderGid,
      metafields: [{
        namespace: 'bunjang',
        key: 'last_status_sync',
        value: new Date().toISOString(),
        type: 'date_time'
      }, {
        namespace: 'bunjang',
        key: 'last_bunjang_status',
        value: status,
        type: 'single_line_text_field'
      }]
    });
  }
}

/**
 * Shopify fulfillment 상태를 업데이트합니다.
 * @param {string} shopifyOrderGid - Shopify 주문 GID
 * @param {string} bunjangStatus - 번개장터 주문 상태
 * @param {object} orderItem - 번개장터 주문 아이템
 * @param {string} jobId - 작업 ID
 */
async function updateShopifyFulfillmentStatus(shopifyOrderGid, bunjangStatus, orderItem, jobId) {
  // TODO: Shopify Fulfillment API를 사용한 배송 상태 업데이트 구현
  // 이 부분은 Shopify의 Fulfillment API와 연동하여 구현해야 합니다.
  logger.info(`[OrderSvc:Job-${jobId}] TODO: Update Shopify fulfillment for order ${shopifyOrderGid} with Bunjang status ${bunjangStatus}`);
  
  // 예시 구현:
  // if (bunjangStatus === 'IN_TRANSIT') {
  //   const fulfillmentMutation = `
  //     mutation fulfillmentCreateV2($fulfillment: FulfillmentInput!) {
  //       fulfillmentCreateV2(fulfillment: $fulfillment) {
  //         fulfillment {
  //           id
  //           status
  //         }
  //         userErrors {
  //           field
  //           message
  //         }
  //       }
  //     }
  //   `;
  //   
  //   const fulfillmentInput = {
  //     notifyCustomer: true,
  //     trackingInfo: {
  //       company: "배송 회사",
  //       number: "운송장 번호",
  //       url: "추적 URL"
  //     }
  //   };
  //   
  //   await shopifyService.shopifyGraphqlRequest(fulfillmentMutation, { fulfillment: fulfillmentInput });
  // }
}

module.exports = {
  processShopifyOrderForBunjang, // 웹훅 핸들러가 호출
  syncBunjangOrderStatuses, // 주문 상태 동기화
  updateShopifyOrderFromBunjangStatus, // 개별 주문 상태 업데이트
};