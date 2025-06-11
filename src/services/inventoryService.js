// src/services/inventoryService.js
// Shopify와 번개장터 간의 재고 동기화를 담당하는 서비스

const config = require('../config');
const logger = require('../config/logger');
const shopifyService = require('./shopifyService');
const bunjangService = require('./bunjangService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ValidationError } = require('../utils/customErrors');

// BunJang Warehouse 위치 ID 상수
const BUNJANG_WAREHOUSE_GID = 'gid://shopify/Location/82604261625';
const BUNJANG_WAREHOUSE_ID = '82604261625';

/**
 * 번개장터 재고를 Shopify로 동기화
 * 번개장터는 단일 재고 시스템이므로 항상 재고를 1로 설정합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {number} bunjangQuantity - 번개장터 재고 수량 (사용하지 않음, 항상 1로 설정)
 * @returns {Promise<boolean>} 동기화 성공 여부
 */
async function syncBunjangInventoryToShopify(bunjangPid, bunjangQuantity) {
  try {
    logger.info(`[InventorySvc] Syncing inventory for Bunjang PID ${bunjangPid}: Always setting to 1 unit`);
    
    // DB에서 연결된 Shopify 상품 찾기
    const syncedProduct = await SyncedProduct.findOne({ bunjangPid }).lean();
    if (!syncedProduct || !syncedProduct.shopifyGid) {
      logger.warn(`[InventorySvc] No Shopify product found for Bunjang PID ${bunjangPid}`);
      return false;
    }
    
    // *** 중요: 번개장터는 단일 재고이므로 항상 1로 설정 ***
    const normalizedQuantity = 1;
    
    // BunJang Warehouse 위치 ID 상수
    const BUNJANG_WAREHOUSE_GID = 'gid://shopify/Location/82604261625';

    // Shopify 상품의 variant 정보 가져오기
    const query = `
      query getProductVariants($id: ID!) {
        product(id: $id) {
          id
          variants(first: 1) {
            edges {
              node {
                id
                inventoryItem {
                  id
                  tracked
                  inventoryLevels(first: 10) {
                    edges {
                      node {
                        id
                        location {
                          id
                          name
                        }
                        available
                      }
                    }
                  }
                }
                inventoryQuantity
              }
            }
          }
        }
      }`;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: syncedProduct.shopifyGid });
    
    if (!response.data?.product || !response.data.product.variants.edges.length) {
      logger.error(`[InventorySvc] Failed to fetch Shopify product variants for GID ${syncedProduct.shopifyGid}`);
      return false;
    }
    
    const variant = response.data.product.variants.edges[0].node;
    const inventoryItemId = variant.inventoryItem.id;
    const inventoryLevels = variant.inventoryItem?.inventoryLevels?.edges || [];
    
    // 현재 재고 위치 정보 로깅
    logger.info(`[InventorySvc] Current inventory levels for PID ${bunjangPid}:`);
    inventoryLevels.forEach(edge => {
      logger.info(`[InventorySvc]   - ${edge.node.location.name} (${edge.node.location.id}): ${edge.node.available} units`);
    });
    
    // 재고 추적이 비활성화되어 있으면 먼저 활성화
    if (!variant.inventoryItem.tracked) {
      logger.info(`[InventorySvc] Enabling inventory tracking for variant ${variant.id}`);
      await shopifyService.enableInventoryTracking(inventoryItemId);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // BunJang Warehouse에 연결
    logger.info(`[InventorySvc] Activating inventory at BunJang Warehouse...`);
    await shopifyService.activateInventoryAtLocation(inventoryItemId, BUNJANG_WAREHOUSE_GID);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 재고를 항상 1로 설정 (BunJang Warehouse만)
    logger.info(`[InventorySvc] Setting inventory to 1 ONLY at BunJang Warehouse...`);
    
    const setQuantityMutation = `
      mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) {
          inventoryAdjustmentGroup {
            id
            createdAt
            reason
            changes {
              name
              delta
              quantityAfterChange
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`;
    
    const setQuantityResponse = await shopifyService.shopifyGraphqlRequest(setQuantityMutation, {
      input: {
        reason: "correction",
        setQuantities: [{
          inventoryItemId: inventoryItemId,
          locationId: BUNJANG_WAREHOUSE_GID,
          quantity: normalizedQuantity  // 항상 1
        }]
      }
    });
    
    if (setQuantityResponse.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
      const errors = setQuantityResponse.data.inventorySetOnHandQuantities.userErrors;
      const errorMessage = errors.map(e => `${e.code}: ${e.message}`).join(', ');
      logger.error(`[InventorySvc] Failed to set inventory quantities: ${errorMessage}`);
      throw new Error(`Failed to set inventory: ${errorMessage}`);
    }
    
    const changes = setQuantityResponse.data?.inventorySetOnHandQuantities?.inventoryAdjustmentGroup?.changes || [];
    logger.info(`[InventorySvc] ✅ Successfully updated inventory. Changes:`, changes);
    
    // 최종 확인 - 실제로 설정되었는지 검증
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const finalCheckQuery = `
      query getInventoryLevels($itemId: ID!) {
        inventoryItem(id: $itemId) {
          id
          inventoryLevels(first: 20) {
            edges {
              node {
                location {
                  id
                  name
                }
                available
              }
            }
          }
        }
      }`;
    
    const finalCheckResponse = await shopifyService.shopifyGraphqlRequest(finalCheckQuery, { itemId: inventoryItemId });
    const finalLevels = finalCheckResponse.data?.inventoryItem?.inventoryLevels?.edges || [];
    
    logger.info(`[InventorySvc] Final inventory verification for PID ${bunjangPid}:`);
    let bunjangWarehouseCorrect = false;
    
    for (const level of finalLevels) {
      const locationId = level.node.location.id;
      const locationName = level.node.location.name;
      const available = level.node.available;
      
      if (locationId === BUNJANG_WAREHOUSE_GID) {
        bunjangWarehouseCorrect = (available === normalizedQuantity);
        logger.info(`[InventorySvc]   - ${locationName}: ${available} units ${bunjangWarehouseCorrect ? '✅' : '❌'} (expected: ${normalizedQuantity})`);
        
        // 재고가 1이 아니면 강제로 재설정
        if (!bunjangWarehouseCorrect) {
          logger.warn(`[InventorySvc] ❌ Inventory not set correctly! Forcing to 1...`);
          await shopifyService.updateInventoryLevel(inventoryItemId, BUNJANG_WAREHOUSE_GID, 1);
          logger.info(`[InventorySvc] ✅✅ Inventory forced to 1 at BunJang Warehouse`);
        }
      } else {
        logger.info(`[InventorySvc]   - ${locationName}: ${available} units (other location)`);
      }
    }
    
    if (bunjangWarehouseCorrect) {
      logger.info(`[InventorySvc] ✅✅ Inventory correctly set to 1 for PID ${bunjangPid}`);
    } else {
      logger.error(`[InventorySvc] ❌ Inventory verification failed for PID ${bunjangPid}`);
    }
    
    // DB 업데이트
    await SyncedProduct.updateOne(
      { bunjangPid },
      { 
        $set: { 
          bunjangQuantity: normalizedQuantity,
          lastInventorySyncAt: new Date()
        }
      }
    );
    
    return true;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to sync inventory for PID ${bunjangPid}:`, error);
    throw error;
  }
}
/**
 * 여러 상품의 재고를 일괄 동기화
 * @param {Array<{pid: string, quantity: number}>} inventoryUpdates - 재고 업데이트 목록
 * @returns {Promise<{success: number, failed: number, deleted: number}>} 동기화 결과
 */
async function batchSyncInventory(inventoryUpdates) {
  const results = {
    success: 0,
    failed: 0,
    deleted: 0,
    details: []
  };
  
  for (const update of inventoryUpdates) {
    try {
      // 항상 재고를 1로 설정
      const result = await syncBunjangInventoryToShopify(update.pid, 1);
      if (result) {
        results.success++;
        results.details.push({
          pid: update.pid,
          success: true,
          quantity: 1  // 항상 1
        });
      } else {
        results.failed++;
        results.details.push({
          pid: update.pid,
          success: false,
          quantity: 1
        });
      }
    } catch (error) {
      results.failed++;
      results.details.push({
        pid: update.pid,
        success: false,
        error: error.message
      });
    }
  }
  
  logger.info(`[InventorySvc] Batch inventory sync completed:`, results);
  return results;
}

/**
 * Shopify 주문 후 번개장터 재고 확인 및 동기화
 * 번개장터는 단일 재고이므로 주문 후에도 재고를 1로 유지합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @returns {Promise<number>} 현재 재고 수량 (항상 1)
 */
async function checkAndSyncBunjangInventory(bunjangPid) {
  try {
    // 번개장터 상품 상세 정보 조회
    const productDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
    
    if (!productDetails) {
      logger.warn(`[InventorySvc] Could not fetch Bunjang product details for PID ${bunjangPid}`);
      return -1;
    }
    
    // 번개장터는 단일 재고이므로 항상 1로 동기화
    await syncBunjangInventoryToShopify(bunjangPid, 1);
    
    return 1; // 항상 1 반환
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to check and sync inventory for PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 재고 부족 상품 확인
 * 번개장터는 단일 재고 시스템이므로 이 함수는 사용하지 않습니다.
 * @returns {Promise<Array>} 빈 배열
 */
async function checkLowStockProducts() {
  try {
    // 번개장터는 단일 재고이므로 재고 부족 체크는 의미가 없음
    logger.info(`[InventorySvc] Low stock check not applicable for Bunjang single-stock system`);
    return [];
    
  } catch (error) {
    logger.error('[InventorySvc] Failed to check low stock products:', error);
    throw error;
  }
}

/**
 * 재고 알림 발송
 * @param {Array} lowStockProducts - 재고 부족 상품 목록
 */
async function sendLowStockNotification(lowStockProducts) {
  if (!lowStockProducts || lowStockProducts.length === 0) return;
  
  logger.warn(`[InventorySvc] Out of stock alert for ${lowStockProducts.length} products:`, 
    lowStockProducts.map(p => `${p.productName} (PID: ${p.bunjangPid})`)
  );
  
  // TODO: 이메일 또는 Slack 알림 발송
  // if (config.notifications.enabled) {
  //   await notificationService.sendLowStockAlert(lowStockProducts);
  // }
}

/**
 * 전체 재고 동기화 작업
 * 모든 상품의 재고를 1로 설정합니다.
 * @param {string} [jobId='MANUAL'] - 작업 ID
 * @returns {Promise<object>} 동기화 결과
 */
async function performFullInventorySync(jobId = 'MANUAL') {
  logger.info(`[InventorySvc:Job-${jobId}] Starting full inventory sync`);
  
  const startTime = Date.now();
  const results = {
    totalProducts: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    deleted: 0,
    outOfStock: []
  };
  
  try {
    // 동기화된 모든 상품 조회
    const syncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      bunjangPid: { $exists: true }
    }).limit(1000).lean(); // 한 번에 최대 1000개 처리
    
    results.totalProducts = syncedProducts.length;
    
    // 각 상품의 재고를 1로 설정
    for (const product of syncedProducts) {
      try {
        const success = await syncBunjangInventoryToShopify(product.bunjangPid, 1);
        
        if (success) {
          results.synced++;
        } else {
          results.skipped++;
        }
        
      } catch (error) {
        results.failed++;
        logger.error(`[InventorySvc:Job-${jobId}] Failed to sync inventory for PID ${product.bunjangPid}:`, error.message);
      }
      
      // Rate limiting - 1초에 2개 상품 처리
      if (results.synced % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info(`[InventorySvc:Job-${jobId}] Full inventory sync completed in ${duration}ms:`, {
      total: results.totalProducts,
      synced: results.synced,
      failed: results.failed,
      skipped: results.skipped
    });
    
    return results;
    
  } catch (error) {
    logger.error(`[InventorySvc:Job-${jobId}] Full inventory sync failed:`, error);
    throw error;
  }
}

/**
 * 재고가 0이 되었을 때 상품을 삭제합니다.
 * 번개장터는 단일 재고이므로 이 함수는 사용하지 않습니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {string} shopifyGid - Shopify 상품 GID
 * @returns {Promise<boolean>} 삭제 성공 여부
 */
async function deleteProductIfOutOfStock(bunjangPid, shopifyGid) {
  try {
    logger.info(`[InventorySvc] Product deletion skipped. Bunjang single-stock items should always have inventory 1. PID: ${bunjangPid}`);
    
    // 삭제 대신 재고를 1로 유지
    await syncBunjangInventoryToShopify(bunjangPid, 1);
    
    return false; // 삭제하지 않음
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to handle out-of-stock product PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 주문 처리 후 재고 업데이트
 * 번개장터 상품은 단일 재고이므로 주문 후에도 재고를 1로 유지합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {number} orderedQuantity - 주문 수량
 * @returns {Promise<boolean>} 처리 성공 여부
 */
async function processOrderInventoryUpdate(bunjangPid, orderedQuantity = 1) {
  try {
    logger.info(`[InventorySvc] Processing order for PID ${bunjangPid}, maintaining inventory at 1`);
    
    // 번개장터는 단일 재고이므로 주문 후에도 재고를 1로 유지
    await syncBunjangInventoryToShopify(bunjangPid, 1);
    
    logger.info(`[InventorySvc] Inventory maintained at 1 for PID ${bunjangPid} after order`);
    
    return true;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to process order inventory update for PID ${bunjangPid}:`, error);
    throw error;
  }
}

module.exports = {
  syncBunjangInventoryToShopify,
  batchSyncInventory,
  checkAndSyncBunjangInventory,
  checkLowStockProducts,
  sendLowStockNotification,
  performFullInventorySync,
  deleteProductIfOutOfStock,
  processOrderInventoryUpdate,
};