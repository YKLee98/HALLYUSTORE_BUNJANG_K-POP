// forceInventoryToOne.js - 재고를 강제로 1로 설정하는 헬퍼 함수

/**
 * 재고를 강제로 1로 설정하는 함수
 * 모든 안전장치를 무시하고 확실하게 재고를 1로 만듭니다
 */
async function forceInventoryToOne(inventoryItemId, shopifyService, logger) {
  const BUNJANG_WAREHOUSE_GID = 'gid://shopify/Location/82604261625';
  
  logger.info(`[ForceInventory] === 강제 재고 설정 시작 ===`);
  logger.info(`[ForceInventory] Inventory Item ID: ${inventoryItemId}`);
  
  try {
    // Step 1: 재고 추적 강제 활성화
    logger.info(`[ForceInventory] Step 1: 재고 추적 강제 활성화`);
    const enableTrackingMutation = `
      mutation forceEnableTracking($id: ID!) {
        inventoryItemUpdate(id: $id, input: { tracked: true }) {
          inventoryItem {
            id
            tracked
          }
          userErrors {
            field
            message
          }
        }
      }`;
    
    const trackingResponse = await shopifyService.shopifyGraphqlRequest(enableTrackingMutation, {
      id: inventoryItemId
    });
    
    if (trackingResponse.data?.inventoryItemUpdate?.userErrors?.length > 0) {
      logger.error(`[ForceInventory] 재고 추적 활성화 실패:`, trackingResponse.data.inventoryItemUpdate.userErrors);
    } else {
      logger.info(`[ForceInventory] ✅ 재고 추적 활성화 완료`);
    }
    
    // 잠시 대기
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 2: 모든 위치의 재고 확인
    logger.info(`[ForceInventory] Step 2: 모든 위치의 재고 상태 확인`);
    const checkQuery = `
      query checkAllInventoryLevels($itemId: ID!) {
        inventoryItem(id: $itemId) {
          id
          tracked
          inventoryLevels(first: 50) {
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
      }`;
    
    const checkResponse = await shopifyService.shopifyGraphqlRequest(checkQuery, { itemId: inventoryItemId });
    const allLevels = checkResponse.data?.inventoryItem?.inventoryLevels?.edges || [];
    
    logger.info(`[ForceInventory] 현재 ${allLevels.length}개 위치에 재고 연결됨`);
    
    // Step 3: BunJang Warehouse가 없으면 연결
    const bunjangLevel = allLevels.find(edge => edge.node.location.id === BUNJANG_WAREHOUSE_GID);
    
    if (!bunjangLevel) {
      logger.info(`[ForceInventory] Step 3: BunJang Warehouse 연결 필요`);
      
      const activateMutation = `
        mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel {
              id
              available
            }
            userErrors {
              field
              message
              code
            }
          }
        }`;
      
      const activateResponse = await shopifyService.shopifyGraphqlRequest(activateMutation, {
        inventoryItemId: inventoryItemId,
        locationId: BUNJANG_WAREHOUSE_GID
      });
      
      if (activateResponse.data?.inventoryActivate?.userErrors?.length > 0) {
        logger.error(`[ForceInventory] BunJang Warehouse 연결 실패:`, activateResponse.data.inventoryActivate.userErrors);
      } else {
        logger.info(`[ForceInventory] ✅ BunJang Warehouse 연결 완료`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    // Step 4: 모든 위치의 재고를 0으로 리셋 (BunJang 제외)
    logger.info(`[ForceInventory] Step 4: 다른 모든 위치의 재고를 0으로 리셋`);
    
    const resetQuantities = [];
    for (const edge of allLevels) {
      if (edge.node.location.id !== BUNJANG_WAREHOUSE_GID && edge.node.available > 0) {
        resetQuantities.push({
          inventoryItemId: inventoryItemId,
          locationId: edge.node.location.id,
          quantity: 0
        });
        logger.info(`[ForceInventory]   - ${edge.node.location.name}: ${edge.node.available} -> 0`);
      }
    }
    
    if (resetQuantities.length > 0) {
      const resetMutation = `
        mutation resetOtherLocations($input: InventorySetOnHandQuantitiesInput!) {
          inventorySetOnHandQuantities(input: $input) {
            inventoryAdjustmentGroup {
              id
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
      
      await shopifyService.shopifyGraphqlRequest(resetMutation, {
        input: {
          reason: "correction",
          setQuantities: resetQuantities
        }
      });
      
      logger.info(`[ForceInventory] ✅ 다른 위치들의 재고를 0으로 리셋 완료`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Step 5: BunJang Warehouse에 재고를 1로 강제 설정
    logger.info(`[ForceInventory] Step 5: BunJang Warehouse에 재고를 1로 강제 설정`);
    
    const setQuantityMutation = `
      mutation forceSetQuantity($input: InventorySetOnHandQuantitiesInput!) {
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
    
    const setResponse = await shopifyService.shopifyGraphqlRequest(setQuantityMutation, {
      input: {
        reason: "correction",
        setQuantities: [{
          inventoryItemId: inventoryItemId,
          locationId: BUNJANG_WAREHOUSE_GID,
          quantity: 1
        }]
      }
    });
    
    if (setResponse.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
      logger.error(`[ForceInventory] 재고 설정 실패:`, setResponse.data.inventorySetOnHandQuantities.userErrors);
      throw new Error('재고를 1로 설정하는데 실패했습니다');
    }
    
    const changes = setResponse.data?.inventorySetOnHandQuantities?.inventoryAdjustmentGroup?.changes || [];
    logger.info(`[ForceInventory] ✅ 재고 변경 완료:`, changes);
    
    // Step 6: 최종 검증
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info(`[ForceInventory] Step 6: 최종 검증`);
    const finalCheckResponse = await shopifyService.shopifyGraphqlRequest(checkQuery, { itemId: inventoryItemId });
    const finalLevels = finalCheckResponse.data?.inventoryItem?.inventoryLevels?.edges || [];
    
    let totalInventory = 0;
    let bunjangInventory = 0;
    
    for (const edge of finalLevels) {
      const available = edge.node.available;
      totalInventory += available;
      
      if (edge.node.location.id === BUNJANG_WAREHOUSE_GID) {
        bunjangInventory = available;
        logger.info(`[ForceInventory]   - BunJang Warehouse: ${available} ${available === 1 ? '✅' : '❌'}`);
      } else if (available > 0) {
        logger.warn(`[ForceInventory]   - ${edge.node.location.name}: ${available} (경고: 0이어야 함)`);
      }
    }
    
    logger.info(`[ForceInventory] 최종 결과 - 총 재고: ${totalInventory}, BunJang 재고: ${bunjangInventory}`);
    
    if (bunjangInventory !== 1) {
      logger.error(`[ForceInventory] ❌❌ 최종 검증 실패! BunJang Warehouse 재고가 ${bunjangInventory}입니다`);
      
      // 한 번 더 시도
      logger.info(`[ForceInventory] 마지막으로 한 번 더 시도...`);
      await shopifyService.shopifyGraphqlRequest(setQuantityMutation, {
        input: {
          reason: "other",
          setQuantities: [{
            inventoryItemId: inventoryItemId,
            locationId: BUNJANG_WAREHOUSE_GID,
            quantity: 1
          }]
        }
      });
    } else {
      logger.info(`[ForceInventory] ✅✅✅ 성공! 재고가 1로 설정되었습니다`);
    }
    
    logger.info(`[ForceInventory] === 강제 재고 설정 완료 ===`);
    return true;
    
  } catch (error) {
    logger.error(`[ForceInventory] ❌ 강제 재고 설정 중 오류 발생:`, error);
    throw error;
  }
}

module.exports = {
  forceInventoryToOne
};