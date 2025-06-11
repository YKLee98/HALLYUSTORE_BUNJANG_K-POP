// initialCatalogSync.js
// 번개장터 상품을 Shopify로 처음 동기화하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const { fetchAndProcessBunjangCatalog } = require('./src/services/catalogService');
const logger = require('./src/config/logger');

const MONGODB_URI = config.mongodb?.uri || config.mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/bunjang-shopify';

async function runInitialSync() {
  try {
    // MongoDB 연결
    if (mongoose.connection.readyState === 0) {
      console.log('🔄 Connecting to MongoDB...');
      await mongoose.connect(MONGODB_URI);
      console.log('✅ MongoDB connected\n');
    }
    
    console.log('🚀 Starting initial Bunjang catalog sync to Shopify');
    console.log('=' .repeat(60));
    console.log('⚠️  This will import Bunjang products to your Shopify store');
    console.log('⚠️  Make sure your Bunjang API credentials are configured in .env');
    console.log('=' .repeat(60) + '\n');
    
    // 카탈로그 타입 선택 (full 또는 segment)
    const catalogType = 'segment'; // 처음에는 segment로 테스트하는 것이 좋습니다
    
    console.log(`📦 Fetching ${catalogType} catalog from Bunjang...`);
    console.log('This may take a few minutes depending on the catalog size.\n');
    
    const startTime = Date.now();
    
    // 카탈로그 동기화 실행
    const result = await fetchAndProcessBunjangCatalog(catalogType, 'INITIAL_SYNC');
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n' + '=' .repeat(60));
    console.log('✅ Initial sync completed!');
    console.log('=' .repeat(60));
    console.log(`📊 Sync Summary:`);
    console.log(`   - Catalog file: ${result.filename}`);
    console.log(`   - Total CSV rows: ${result.totalOriginalCsvRows}`);
    console.log(`   - Valid products found: ${result.validProductsToProcess}`);
    console.log(`   - Successfully synced: ${result.successfullyProcessed}`);
    console.log(`   - Skipped (filtered): ${result.skippedByFilter}`);
    console.log(`   - Skipped (no change): ${result.skippedNoChange}`);
    console.log(`   - Errors: ${result.errors}`);
    console.log(`   - Duration: ${duration} seconds`);
    console.log('=' .repeat(60) + '\n');
    
    if (result.successfullyProcessed > 0) {
      console.log('✅ Products have been imported to Shopify!');
      console.log('🔍 Check your Shopify admin to see the imported products.');
      console.log('🏷️  They should be in the "Bunjang" collection.');
      
      // 특정 PID가 동기화되었는지 확인
      const SyncedProduct = require('./src/models/syncedProduct.model');
      const targetPid = '337497237';
      const syncedTarget = await SyncedProduct.findOne({ bunjangPid: targetPid }).lean();
      
      if (syncedTarget) {
        console.log(`\n✅ Good news! Product PID ${targetPid} was synced:`);
        console.log(`   - Shopify ID: ${syncedTarget.shopifyGid}`);
        console.log(`   - Product Name: ${syncedTarget.bunjangProductName}`);
      } else {
        console.log(`\n⚠️  Product PID ${targetPid} was not found in this sync.`);
        console.log('   It might not be in the catalog or might have been filtered out.');
      }
    } else {
      console.log('⚠️  No products were successfully synced.');
      console.log('   Check the logs for error details.');
    }
    
  } catch (error) {
    console.error('\n❌ Initial sync failed:', error.message);
    console.error('Stack trace:', error.stack);
    
    if (error.message.includes('Bunjang API credentials')) {
      console.error('\n🔑 Please check your .env file for:');
      console.error('   - BUNJANG_ACCESS_KEY');
      console.error('   - BUNJANG_SECRET_KEY');
      console.error('   - BUNJANG_CATALOG_API_URL');
    }
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

// 실행
if (require.main === module) {
  runInitialSync();
}