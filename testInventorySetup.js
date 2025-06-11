// testInventorySetup.js - 재고 설정이 제대로 작동하는지 테스트

const shopifyService = require('./src/services/shopifyService');
const logger = require('./src/config/logger');

async function testInventorySetup(productGid) {
  try {
    logger.info('=== Starting Inventory Setup Test ===');
    
    // 1. 제품 정보 가져오기
    const productQuery = `
      query getProductDetails($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 1) {
            edges {
              node {
                id
                sku
                price
                inventoryQuantity
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
              }
            }
          }
        }
      }
    `;
    
    const productResponse = await shopifyService.shopifyGraphqlRequest(productQuery, { id: productGid });
    const product = productResponse.data?.product;
    
    if (!product) {
      logger.error('Product not found');
      return;
    }
    
    logger.info(`Product: ${product.title}`);
    
    const variant = product.variants.edges[0]?.node;
    if (!variant) {
      logger.error('No variant found');
      return;
    }
    
    const inventoryItemId = variant.inventoryItem?.id;
    logger.info(`Variant ID: ${variant.id}`);
    logger.info(`SKU: ${variant.sku}`);
    logger.info(`Price: ${variant.price}`);
    logger.info(`Inventory Item ID: ${inventoryItemId}`);
    logger.info(`Inventory Tracked: ${variant.inventoryItem?.tracked}`);
    logger.info(`Current Total Quantity: ${variant.inventoryQuantity}`);
    
    // 현재 재고 위치 정보
    const currentLevels = variant.inventoryItem?.inventoryLevels?.edges || [];
    logger.info('\nCurrent Inventory Levels:');
    currentLevels.forEach(edge => {
      const level = edge.node;
      logger.info(`  - ${level.location.name} (${level.location.id}): ${level.available} units`);
    });
    
    // 2. 재고 추적 활성화 (필요한 경우)
    if (!variant.inventoryItem?.tracked) {
      logger.info('\n=== Enabling Inventory Tracking ===');
      await shopifyService.enableInventoryTracking(inventoryItemId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.info('✅ Inventory tracking enabled');
    }
    
    // 3. BunJang Warehouse에 연결 (필요한 경우)
    const bunjangLocationId = 'gid://shopify/Location/82604261625';
    const isConnectedToBunJang = currentLevels.some(e => e.node.location.id === bunjangLocationId);
    
    if (!isConnectedToBunJang) {
      logger.info('\n=== Connecting to BunJang Warehouse ===');
      await shopifyService.activateInventoryAtLocation(inventoryItemId, bunjangLocationId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.info('✅ Connected to BunJang Warehouse');
    }
    
    // 4. 재고를 1로 설정
    logger.info('\n=== Setting Inventory to 1 ===');
    await shopifyService.updateInventoryLevel(inventoryItemId, bunjangLocationId, 1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 5. 최종 확인
    logger.info('\n=== Final Verification ===');
    const finalResponse = await shopifyService.shopifyGraphqlRequest(productQuery, { id: productGid });
    const finalVariant = finalResponse.data?.product?.variants?.edges?.[0]?.node;
    
    if (finalVariant) {
      logger.info(`Final Total Quantity: ${finalVariant.inventoryQuantity}`);
      
      const finalLevels = finalVariant.inventoryItem?.inventoryLevels?.edges || [];
      logger.info('\nFinal Inventory Levels:');
      finalLevels.forEach(edge => {
        const level = edge.node;
        const isBunJang = level.location.id === bunjangLocationId;
        logger.info(`  ${isBunJang ? '✅' : '-'} ${level.location.name} (${level.location.id}): ${level.available} units`);
      });
      
      const bunjangLevel = finalLevels.find(e => e.node.location.id === bunjangLocationId);
      if (bunjangLevel && bunjangLevel.node.available === 1) {
        logger.info('\n✅✅✅ SUCCESS: Inventory is correctly set to 1 at BunJang Warehouse!');
      } else {
        logger.error('\n❌❌❌ FAILED: Inventory setup failed!');
      }
    }
    
  } catch (error) {
    logger.error('Test failed:', error);
  }
}

// 사용 예시:
// testInventorySetup('gid://shopify/Product/YOUR_PRODUCT_ID');

module.exports = { testInventorySetup };