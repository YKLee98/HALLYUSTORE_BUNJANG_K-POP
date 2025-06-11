// fixZeroPrices.js - 0원으로 설정된 상품들의 가격을 수정하는 스크립트
// 프로젝트 루트에 저장하고 실행: node fixZeroPrices.js

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('./src/config');
const logger = require('./src/config/logger');
const shopifyService = require('./src/services/shopifyService');
const SyncedProduct = require('./src/models/syncedProduct.model');
const { calculateShopifyPriceUsd } = require('./src/services/priceCalculationService');

async function fixZeroPrices() {
  logger.info('[FixZeroPrices] Starting price fix for products with $0.00 price...');
  
  try {
    // MongoDB 연결 - config.database.connectionString 사용
    const mongoUri = config.database?.connectionString || process.env.DB_CONNECTION_STRING || 'mongodb://localhost:27017/bunjangShopifyIntegrationDB_development';
    
    logger.info(`[FixZeroPrices] Connecting to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      ...(config.database?.options || {})
    });
    
    logger.info('[FixZeroPrices] Connected to MongoDB');
    
    // 동기화된 모든 상품 조회
    const syncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      shopifyGid: { $exists: true },
      bunjangOriginalPriceKrw: { $exists: true, $gt: 0 }
    }).limit(100).lean(); // 한 번에 최대 100개 처리
    
    logger.info(`[FixZeroPrices] Found ${syncedProducts.length} synced products to check`);
    
    let fixedCount = 0;
    let errorCount = 0;
    let checkedCount = 0;
    
    for (const product of syncedProducts) {
      try {
        checkedCount++;
        
        // Shopify에서 현재 가격 확인
        const query = `
          query getProductPrice($id: ID!) {
            product(id: $id) {
              id
              title
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                  }
                }
              }
            }
          }`;
        
        const response = await shopifyService.shopifyGraphqlRequest(query, { id: product.shopifyGid });
        
        if (!response.data?.product?.variants?.edges?.length) {
          logger.warn(`[FixZeroPrices] No variants found for product ${product.shopifyGid}`);
          continue;
        }
        
        const variant = response.data.product.variants.edges[0].node;
        const currentPrice = parseFloat(variant.price || '0');
        
        logger.info(`[FixZeroPrices] [${checkedCount}/${syncedProducts.length}] Product ${product.bunjangPid} (${response.data.product.title}) - Current price: $${currentPrice.toFixed(2)}`);
        
        // 가격이 0이거나 매우 낮은 경우 수정
        if (currentPrice <= 0.01) {
          // 가격 재계산
          const newPriceString = await calculateShopifyPriceUsd(product.bunjangOriginalPriceKrw);
          const newPrice = parseFloat(newPriceString);
          
          logger.info(`[FixZeroPrices] 🔧 Updating price for ${product.bunjangPid}: $${currentPrice.toFixed(2)} -> $${newPrice.toFixed(2)}`);
          
          // 가격 업데이트
          await shopifyService.updateProductVariant({
            id: variant.id,
            price: newPriceString
          });
          
          // DB 업데이트
          await SyncedProduct.updateOne(
            { bunjangPid: product.bunjangPid },
            { 
              $set: { 
                shopifyListedPriceUsd: newPriceString,
                lastPriceFixAt: new Date()
              }
            }
          );
          
          fixedCount++;
          logger.info(`[FixZeroPrices] ✅ Successfully updated price for ${product.bunjangPid}`);
        } else {
          logger.debug(`[FixZeroPrices] Price OK for ${product.bunjangPid}: $${currentPrice.toFixed(2)}`);
        }
        
      } catch (error) {
        errorCount++;
        logger.error(`[FixZeroPrices] ❌ Failed to fix price for ${product.bunjangPid}:`, error.message);
      }
      
      // Rate limiting - 초당 2개 처리
      if (checkedCount % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    logger.info(`[FixZeroPrices] 
    ========================================
    Price fix completed:
    - Checked: ${checkedCount}
    - Fixed: ${fixedCount}
    - Errors: ${errorCount}
    - Already OK: ${checkedCount - fixedCount - errorCount}
    ========================================`);
    
  } catch (error) {
    logger.error('[FixZeroPrices] Fatal error:', error);
    console.error('Error stack:', error.stack);
  } finally {
    try {
      await mongoose.connection.close();
      logger.info('[FixZeroPrices] MongoDB connection closed');
    } catch (closeError) {
      logger.error('[FixZeroPrices] Error closing MongoDB:', closeError);
    }
    process.exit(0);
  }
}

// 실행
fixZeroPrices();