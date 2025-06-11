// src/scripts/syncAllBunjangTaggedProducts.js
const mongoose = require('mongoose');
const config = require('../config');
const SyncedProduct = require('../models/syncedProduct.model');
const shopifyService = require('../services/shopifyService');
const logger = require('../config/logger');

async function syncAllBunjangTaggedProducts() {
  try {
    // MongoDB 연결
    const mongoUri = config.database.connectionString;
    
    if (!mongoUri) {
      logger.error('MongoDB URI not found in config');
      return;
    }
    
    logger.info(`🚀 Starting sync for all bunjang_pid tagged products...`);
    logger.info(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri, config.database.options);
    logger.info(`✅ Connected to MongoDB successfully`);
    
    let hasNextPage = true;
    let cursor = null;
    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    while (hasNextPage) {
      // bunjang_pid 태그가 있는 모든 상품 조회
      const query = `
        query getTaggedProducts($cursor: String) {
          products(first: 50, after: $cursor, query: "tag:bunjang_pid") {
            edges {
              node {
                id
                title
                handle
                tags
                status
                variants(first: 1) {
                  edges {
                    node {
                      id
                      sku
                    }
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `;
      
      try {
        const response = await shopifyService.shopifyGraphqlRequest(query, { cursor });
        
        if (!response.data || !response.data.products) {
          logger.error('No products data in response');
          break;
        }
        
        const products = response.data.products.edges || [];
        hasNextPage = response.data.products.pageInfo?.hasNextPage || false;
        
        logger.info(`📦 Found ${products.length} products in this batch`);
        
        for (const { node: product, cursor: productCursor } of products) {
          cursor = productCursor;
          
          // bunjang_pid 태그 찾기 (더 정확한 패턴 매칭)
          const bunjangPidTag = product.tags.find(tag => 
            tag.startsWith('bunjang_pid:') || 
            tag.match(/^bunjang_pid:\s*\d+$/)
          );
          
          if (!bunjangPidTag) {
            logger.warn(`⚠️ No valid bunjang_pid tag found for product: ${product.title}`);
            skippedCount++;
            continue;
          }
          
          // bunjang_pid 추출 (콜론 뒤의 숫자)
          const bunjangPid = bunjangPidTag.split(':')[1].trim();
          
          // 유효성 검사
          if (!bunjangPid || isNaN(bunjangPid)) {
            logger.error(`❌ Invalid bunjang_pid format for product ${product.title}: ${bunjangPidTag}`);
            errorCount++;
            continue;
          }
          
          const shopifyProductId = product.id.split('/').pop();
          
          logger.info(`🔄 Processing: ${product.title}`);
          logger.info(`   Shopify ID: ${shopifyProductId}, Bunjang PID: ${bunjangPid}`);
          
          try {
            // DB에 저장 또는 업데이트
            const syncedProduct = await SyncedProduct.findOneAndUpdate(
              { shopifyGid: product.id },
              {
                $set: {
                  shopifyGid: product.id,
                  shopifyData: {
                    id: shopifyProductId,
                    title: product.title,
                    handle: product.handle,
                    status: product.status,
                    sku: product.variants?.edges?.[0]?.node?.sku || ''
                  },
                  bunjangPid: String(bunjangPid),
                  bunjangProductName: product.title,
                  syncStatus: 'SYNCED',
                  lastSyncedAt: new Date(),
                  tags: product.tags
                }
              },
              { upsert: true, new: true, runValidators: true }
            );
            
            syncedCount++;
            logger.info(`✅ Synced: ${product.title} (Shopify: ${shopifyProductId}, Bunjang: ${bunjangPid})`);
            
          } catch (dbError) {
            logger.error(`❌ Failed to save to DB: ${product.title}`, dbError.message);
            errorCount++;
          }
        }
        
      } catch (apiError) {
        logger.error('❌ Shopify API error:', apiError.message);
        break;
      }
    }
    
    // 최종 결과 출력
    logger.info('\n========== SYNC COMPLETE ==========');
    logger.info(`✅ Successfully synced: ${syncedCount} products`);
    logger.info(`⚠️ Skipped (no valid tag): ${skippedCount} products`);
    logger.info(`❌ Errors: ${errorCount} products`);
    logger.info('===================================\n');
    
    // 동기화된 상품 목록 출력
    if (syncedCount > 0) {
      logger.info('📋 Synced products list:');
      const syncedList = await SyncedProduct.find({}).sort({ lastSyncedAt: -1 }).limit(syncedCount);
      syncedList.forEach((product, index) => {
        logger.info(`${index + 1}. ${product.bunjangProductName} - Bunjang PID: ${product.bunjangPid}`);
      });
    }
    
  } catch (error) {
    logger.error('❌ Fatal error during sync:', error);
    console.error('Error details:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    try {
      await mongoose.disconnect();
      logger.info('🔌 Disconnected from MongoDB');
    } catch (disconnectError) {
      logger.error('Error disconnecting from MongoDB:', disconnectError);
    }
  }
}

// 즉시 실행
syncAllBunjangTaggedProducts().then(() => {
  console.log('✨ Script execution completed');
}).catch(err => {
  console.error('💥 Script failed:', err);
  process.exit(1);
});