// checkProductSync.js
// 번개장터 상품과 Shopify 상품의 연동 상태를 확인하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');

const MONGODB_URI = config.mongodb?.uri || config.mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/bunjang-shopify';
const BUNJANG_PID = '337497237';
const ORDER_NUMBER = '72521';

async function checkProductSync() {
  try {
    // MongoDB 연결
    if (mongoose.connection.readyState === 0) {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(MONGODB_URI);
      console.log('✅ MongoDB connected\n');
    }
    
    console.log(`🔍 Checking sync status for Bunjang PID: ${BUNJANG_PID}`);
    console.log(`📦 Order number: #${ORDER_NUMBER}\n`);
    
    // 1. 번개장터 PID로 검색
    console.log('1️⃣ Searching by Bunjang PID...');
    const syncedByPid = await SyncedProduct.findOne({ bunjangPid: BUNJANG_PID }).lean();
    
    if (syncedByPid) {
      console.log('✅ Found synced product:');
      console.log(`   - Bunjang PID: ${syncedByPid.bunjangPid}`);
      console.log(`   - Shopify GID: ${syncedByPid.shopifyGid || 'NOT SET'}`);
      console.log(`   - Product Name: ${syncedByPid.bunjangProductName}`);
      console.log(`   - Sync Status: ${syncedByPid.syncStatus}`);
      console.log(`   - Last Synced: ${syncedByPid.lastSyncAt}`);
    } else {
      console.log('❌ No synced product found with this Bunjang PID');
    }
    
    // 2. 태그로 검색 (bunjang_pid:337497237)
    console.log('\n2️⃣ Searching by tag pattern...');
    const tagPattern = new RegExp(`bunjang_pid:${BUNJANG_PID}`, 'i');
    const syncedByTag = await SyncedProduct.find({
      $or: [
        { 'shopifyData.tags': tagPattern },
        { tags: tagPattern }
      ]
    }).lean();
    
    if (syncedByTag.length > 0) {
      console.log(`✅ Found ${syncedByTag.length} products with matching tag:`);
      syncedByTag.forEach((product, index) => {
        console.log(`\n   Product ${index + 1}:`);
        console.log(`   - MongoDB ID: ${product._id}`);
        console.log(`   - Bunjang PID: ${product.bunjangPid}`);
        console.log(`   - Shopify GID: ${product.shopifyGid}`);
        console.log(`   - Tags: ${product.shopifyData?.tags || product.tags || 'N/A'}`);
      });
    } else {
      console.log('❌ No products found with matching tag');
    }
    
    // 3. 최근 동기화된 상품 확인
    console.log('\n3️⃣ Recent synced products (last 5):');
    const recentProducts = await SyncedProduct.find({ syncStatus: 'SYNCED' })
      .sort({ lastSyncAt: -1 })
      .limit(5)
      .lean();
      
    if (recentProducts.length > 0) {
      recentProducts.forEach((product, index) => {
        console.log(`\n   ${index + 1}. ${product.bunjangProductName}`);
        console.log(`      - Bunjang PID: ${product.bunjangPid}`);
        console.log(`      - Shopify GID: ${product.shopifyGid?.substring(0, 50)}...`);
        console.log(`      - Last Sync: ${product.lastSyncAt}`);
      });
    } else {
      console.log('   No recently synced products found');
    }
    
    // 4. 주문번호와 관련된 Shopify 상품 찾기
    console.log(`\n4️⃣ Searching for products related to order #${ORDER_NUMBER}...`);
    console.log('   (Note: This requires checking Shopify order details)');
    
    // 5. 데이터베이스 통계
    console.log('\n5️⃣ Database statistics:');
    const totalProducts = await SyncedProduct.countDocuments();
    const syncedProducts = await SyncedProduct.countDocuments({ syncStatus: 'SYNCED' });
    const failedProducts = await SyncedProduct.countDocuments({ syncStatus: 'FAILED' });
    
    console.log(`   - Total products: ${totalProducts}`);
    console.log(`   - Synced: ${syncedProducts}`);
    console.log(`   - Failed: ${failedProducts}`);
    
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
  checkProductSync();
}