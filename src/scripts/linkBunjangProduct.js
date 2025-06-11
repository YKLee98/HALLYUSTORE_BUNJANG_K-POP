// scripts/linkBunjangProduct.js
const mongoose = require('mongoose');
const config = require('../src/config');
const SyncedProduct = require('../src/models/syncedProduct.model');
const shopifyService = require('../src/services/shopifyService');

async function linkBunjangProduct(shopifyProductId, bunjangPid) {
  try {
    await mongoose.connect(config.mongodb.uri);
    
    // Shopify 상품 정보 가져오기
    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          tags
        }
      }
    `;
    
    const shopifyGid = `gid://shopify/Product/${shopifyProductId}`;
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: shopifyGid });
    const product = response.data.product;
    
    if (!product) {
      console.error('Shopify product not found');
      return;
    }
    
    // DB에 연결 정보 추가 또는 업데이트
    const syncedProduct = await SyncedProduct.findOneAndUpdate(
      { shopifyGid: shopifyGid },
      {
        $set: {
          shopifyGid: shopifyGid,
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
    
    console.log('Product linked successfully:', syncedProduct);
    
  } catch (error) {
    console.error('Error linking product:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// 사용 예시: node scripts/linkBunjangProduct.js 8837903155449 334261439
const shopifyProductId = process.argv[2];
const bunjangPid = process.argv[3];

if (!shopifyProductId || !bunjangPid) {
  console.error('Usage: node linkBunjangProduct.js <shopifyProductId> <bunjangPid>');
  process.exit(1);
}

linkBunjangProduct(shopifyProductId, bunjangPid);