// linkOrderProduct.js
// Shopify 주문에서 상품을 찾아 번개장터 상품과 연결하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const shopifyService = require('./src/services/shopifyService');
const SyncedProduct = require('./src/models/syncedProduct.model');

const MONGODB_URI = config.mongodb?.uri || config.mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/bunjang-shopify';
const ORDER_NUMBER = '72521';
const BUNJANG_PID = '337497237';

async function linkOrderProduct() {
  try {
    // MongoDB 연결
    if (mongoose.connection.readyState === 0) {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(MONGODB_URI);
      console.log('✅ MongoDB connected\n');
    }
    
    console.log(`🔍 Finding order #${ORDER_NUMBER} in Shopify...\n`);
    
    // 1. Shopify에서 주문 찾기
    const query = `
      query findOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              createdAt
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    title
                    quantity
                    product {
                      id
                      title
                      handle
                      tags
                    }
                    variant {
                      id
                      sku
                      inventoryItem {
                        id
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
    
    const searchQuery = `name:#${ORDER_NUMBER}`;
    const response = await shopifyService.shopifyGraphqlRequest(query, { query: searchQuery });
    
    if (!response.data.orders.edges.length) {
      console.log(`❌ Order #${ORDER_NUMBER} not found in Shopify`);
      return;
    }
    
    const order = response.data.orders.edges[0].node;
    console.log(`✅ Found order: ${order.name}`);
    console.log(`   Created: ${order.createdAt}`);
    console.log(`   Line items: ${order.lineItems.edges.length}\n`);
    
    // 2. 주문 상품 분석
    for (const edge of order.lineItems.edges) {
      const lineItem = edge.node;
      const product = lineItem.product;
      
      console.log(`📦 Product: ${lineItem.title}`);
      console.log(`   - Quantity: ${lineItem.quantity}`);
      console.log(`   - Product ID: ${product?.id || 'N/A'}`);
      console.log(`   - SKU: ${lineItem.variant?.sku || 'N/A'}`);
      console.log(`   - Tags: ${product?.tags?.join(', ') || 'N/A'}\n`);
      
      // 태그에서 번개장터 PID 찾기
      const bunjangTag = product?.tags?.find(tag => tag.includes('bunjang_pid:'));
      if (bunjangTag) {
        const pidFromTag = bunjangTag.split(':')[1];
        console.log(`   🔗 Found Bunjang PID in tags: ${pidFromTag}`);
        
        if (pidFromTag === BUNJANG_PID) {
          console.log(`   ✅ This is the product we're looking for!`);
          
          // 3. DB에 연결 정보 저장/업데이트
          const syncData = {
            bunjangPid: BUNJANG_PID,
            shopifyGid: product.id,
            bunjangProductName: lineItem.title,
            shopifyData: {
              id: product.id.split('/').pop(),
              title: product.title,
              handle: product.handle,
              tags: product.tags,
              variantId: lineItem.variant?.id,
              sku: lineItem.variant?.sku,
              inventoryItemId: lineItem.variant?.inventoryItem?.id
            },
            syncStatus: 'SYNCED',
            lastSyncAt: new Date()
          };
          
          // Upsert (없으면 생성, 있으면 업데이트)
          const result = await SyncedProduct.findOneAndUpdate(
            { bunjangPid: BUNJANG_PID },
            { $set: syncData },
            { upsert: true, new: true }
          );
          
          console.log(`\n   ✅ Product link saved to database!`);
          console.log(`   - MongoDB ID: ${result._id}`);
          console.log(`   - Bunjang PID: ${result.bunjangPid}`);
          console.log(`   - Shopify GID: ${result.shopifyGid}`);
        }
      }
    }
    
    // 4. 수동으로 연결하기 (태그가 없는 경우)
    if (!order.lineItems.edges.some(e => e.node.product?.tags?.some(t => t.includes(`bunjang_pid:${BUNJANG_PID}`)))) {
      console.log('\n⚠️  No product found with matching Bunjang PID in tags.');
      console.log('📝 You may need to manually link the product.');
      
      // 첫 번째 상품을 번개장터 상품과 연결할지 물어보기
      if (order.lineItems.edges.length === 1) {
        const lineItem = order.lineItems.edges[0].node;
        const product = lineItem.product;
        
        console.log(`\n💡 Suggestion: Link "${lineItem.title}" with Bunjang PID ${BUNJANG_PID}?`);
        console.log('   Run the following command to link them:');
        console.log(`   node linkProducts.js --bunjang-pid ${BUNJANG_PID} --shopify-gid "${product?.id}"`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

// 실행
if (require.main === module) {
  linkOrderProduct();
}