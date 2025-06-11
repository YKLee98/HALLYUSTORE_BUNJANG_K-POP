// manualStockSync.js
// 특정 주문의 재고를 수동으로 차감하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const inventoryService = require('./src/services/inventoryService');
const logger = require('./src/config/logger');

// MongoDB URI 직접 가져오기 (config.mongodb가 없는 경우)
const MONGODB_URI = config.mongodb?.uri || config.mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/bunjang-shopify';

// 설정할 값들
const BUNJANG_PID = '337497237';  // 번개장터 상품 ID
const QUANTITY_SOLD = 1;           // 판매된 수량

async function manualStockDeduction() {
  try {
    // MongoDB 연결
    if (mongoose.connection.readyState === 0) {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(MONGODB_URI);
      console.log('✅ MongoDB connected\n');
    }
    
    console.log(`📦 Processing manual stock deduction for Bunjang PID: ${BUNJANG_PID}`);
    console.log(`📉 Quantity to deduct: ${QUANTITY_SOLD}\n`);
    
    // 1. 현재 재고 확인
    console.log('1️⃣ Checking current stock...');
    const currentStock = await inventoryService.checkAndSyncBunjangInventory(BUNJANG_PID);
    
    if (currentStock < 0) {
      console.error('❌ Could not fetch current stock from Bunjang');
      return;
    }
    
    console.log(`   Current stock: ${currentStock} units`);
    
    // 2. 새 재고 계산
    const newStock = Math.max(0, currentStock - QUANTITY_SOLD);
    console.log(`   New stock after deduction: ${newStock} units`);
    
    // 3. Shopify로 동기화
    console.log('\n2️⃣ Syncing to Shopify...');
    const success = await inventoryService.syncBunjangInventoryToShopify(BUNJANG_PID, newStock);
    
    if (success) {
      console.log('✅ Stock successfully updated!');
      console.log(`   ${currentStock} → ${newStock} units`);
    } else {
      console.error('❌ Failed to sync stock to Shopify');
    }
    
  } catch (error) {
    console.error('❌ Error during manual stock sync:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

// 실행
if (require.main === module) {
  manualStockDeduction();
}