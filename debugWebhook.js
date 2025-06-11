// debugWebhook.js
// 실제 Shopify 웹훅 요청을 디버깅하기 위한 스크립트

const express = require('express');
const crypto = require('crypto');
const config = require('./src/config');

const app = express();
const PORT = 3001;

// Raw body를 저장하기 위한 미들웨어
app.use(express.raw({ type: 'application/json' }));

// 모든 웹훅 요청을 캐치하는 라우트
app.post('/webhooks/*', (req, res) => {
  console.log('\n' + '='.repeat(60));
  console.log('🔍 WEBHOOK DEBUG - Incoming Request');
  console.log('='.repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Path: ${req.path}`);
  console.log(`Method: ${req.method}`);
  
  // 헤더 정보
  console.log('\n📋 Headers:');
  Object.keys(req.headers).forEach(key => {
    if (key.toLowerCase().includes('shopify')) {
      console.log(`  ${key}: ${req.headers[key]}`);
    }
  });
  
  // Body 정보
  const bodyString = req.body.toString('utf8');
  console.log(`\n📦 Body (first 200 chars): ${bodyString.substring(0, 200)}...`);
  console.log(`Body length: ${bodyString.length} bytes`);
  
  // 시크릿 테스트
  console.log('\n🔐 Secret Testing:');
  const secrets = [
    { name: 'SHOPIFY_WEBHOOK_SECRET (env)', value: process.env.SHOPIFY_WEBHOOK_SECRET },
    { name: 'config.shopify.webhookSecret', value: config.shopify.webhookSecret },
    { name: 'config.shopify.apiSecret', value: config.shopify.apiSecret }
  ];
  
  secrets.forEach(secret => {
    if (secret.value) {
      console.log(`\n  Testing with ${secret.name}: ${secret.value.substring(0, 20)}...`);
      
      const hash = crypto
        .createHmac('sha256', secret.value)
        .update(bodyString, 'utf8')
        .digest('base64');
      
      const shopifyHmac = req.headers['x-shopify-hmac-sha256'];
      const matches = hash === shopifyHmac;
      
      console.log(`  Generated HMAC: ${hash}`);
      console.log(`  Shopify HMAC:   ${shopifyHmac}`);
      console.log(`  Match: ${matches ? '✅ YES!' : '❌ NO'}`);
    }
  });
  
  // 실제 API Secret으로 직접 테스트
  console.log('\n🔑 Direct API Secret Test:');
  console.log('Enter your actual webhook secret from Shopify Admin:');
  console.log('(Settings → Notifications → Webhooks → Click any webhook → Signing secret)');
  
  // 응답
  res.status(200).json({ 
    message: 'Debug info logged', 
    timestamp: new Date().toISOString() 
  });
});

app.listen(PORT, () => {
  console.log(`\n🐛 Webhook Debug Server running on port ${PORT}`);
  console.log(`\n📝 Next steps:`);
  console.log(`1. Update your webhook URL in Shopify to point to this debug endpoint`);
  console.log(`2. Use ngrok: ngrok http ${PORT}`);
  console.log(`3. Update webhook in Shopify Admin to: https://your-ngrok-url.ngrok-free.app/webhooks/orders/create`);
  console.log(`4. Create a test order and watch the logs\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Debug server shutting down...');
  process.exit(0);
});