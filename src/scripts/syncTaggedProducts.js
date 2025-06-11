// src/scripts/syncTaggedProducts.js
const mongoose = require('mongoose');
const config = require('../config');
const SyncedProduct = require('../models/syncedProduct.model');
const shopifyService = require('../services/shopifyService');
const logger = require('../config/logger');

async function syncAllTaggedProducts() {
  try {
    // config.database.connectionString 사용
    const mongoUri = config.database.connectionString;
    
    if (!mongoUri) {
      logger.error('MongoDB URI not found in config');
      return;
    }
    
    logger.info(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri, config.database.options);
    logger.info(`Connected to MongoDB successfully`);
    
    let hasNextPage = true;
    let cursor = null;
    let syncedCount = 0;
    
    while (hasNextPage) {
      // bunjang_pid 태그가 있는 모든 상품 조회
      const query = `
        query getTaggedProducts($cursor: String) {
          products(first: 50, after: $cursor, query: "tag_prefix:bunjang_pid") {
            edges {
              node {
                id
                title
                handle
                tags
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `;
      
      const response = await shopifyService.shopifyGraphqlRequest(query, { cursor });
      
      if (!response.data || !response.data.products) {
        logger.error('No products data in response');
        break;
      }
      
      const products = response.data.products.edges || [];
      hasNextPage = response.data.products.pageInfo?.hasNextPage || false;
      
      logger.info(`Found ${products.length} products in this batch`);
      
      for (const { node: product, cursor: productCursor } of products) {
        cursor = productCursor;
        
        // bunjang_pid 태그 찾기
        const bunjangPidTag = product.tags.find(tag => tag.startsWith('bunjang_pid:'));
        if (!bunjangPidTag) {
          logger.debug(`No bunjang_pid tag found for product: ${product.title}`);
          continue;
        }
        
        const bunjangPid = bunjangPidTag.split(':')[1].trim();
        const shopifyProductId = product.id.split('/').pop();
        
        logger.info(`Processing: ${product.title} - Shopify ID: ${shopifyProductId}, Bunjang PID: ${bunjangPid}`);
        
        // DB에 저장
        const syncedProduct = await SyncedProduct.findOneAndUpdate(
          { shopifyGid: product.id },
          {
            $set: {
              shopifyGid: product.id,
              shopifyData: {
                id: shopifyProductId,
                title: product.title,
                handle: product.handle
              },
              bunjangPid: String(bunjangPid),
              bunjangProductName: product.title,
              syncStatus: 'SYNCED',
              lastSyncedAt: new Date()
            }
          },
          { upsert: true, new: true }
        );
        
        syncedCount++;
        logger.info(`✅ Synced product: ${product.title} (Shopify: ${shopifyProductId}, Bunjang: ${bunjangPid})`);
      }
    }
    
    logger.info(`🎉 Total products synced: ${syncedCount}`);
    
  } catch (error) {
    logger.error('Error syncing tagged products:', error);
    console.error('Error details:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    try {
      await mongoose.disconnect();
      logger.info('Disconnected from MongoDB');
    } catch (disconnectError) {
      logger.error('Error disconnecting from MongoDB:', disconnectError);
    }
  }
}

// 실행
syncAllTaggedProducts();