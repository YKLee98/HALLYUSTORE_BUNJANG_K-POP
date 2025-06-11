// testWebhookSignature.js
// 웹훅 시그니처 검증을 로컬에서 테스트

const crypto = require('crypto');
const config = require('./src/config');

// 테스트 데이터
const testBody = JSON.stringify({
  id: 12345,
  order_number: "1001",
  line_items: [{
    product_id: 8833906278649,
    variant_id: 123456,
    quantity: 1
  }]
});

// 웹훅 시크릿
const webhookSecret = config.shopify.webhookSecret || config.shopify.apiSecret;

console.log('🔐 Testing Webhook Signature Verification\n');
console.log('Webhook Secret:', webhookSecret ? `${webhookSecret.substring(0, 20)}...` : 'NOT SET');
console.log('Secret Source:', config.shopify.webhookSecret ? 'webhookSecret' : 'apiSecret');
console.log('\nTest Body:', testBody.substring(0, 100) + '...\n');

// HMAC 생성
const hash = crypto
  .createHmac('sha256', webhookSecret)
  .update(testBody, 'utf8')
  .digest('base64');

console.log('Generated HMAC:', hash);
console.log('\n📝 To test manually with curl:\n');

console.log(`curl -X POST ${config.middlewareBaseUrl}/webhooks/test \\
  -H "Content-Type: application/json" \\
  -H "X-Shopify-Hmac-Sha256: ${hash}" \\
  -d '${testBody}'`);

console.log('\n\n💡 If you get 401 Unauthorized:');
console.log('1. Check SHOPIFY_WEBHOOK_SECRET in .env');
console.log('2. Make sure it matches the webhook secret in Shopify');
console.log('3. Shopify Admin → Settings → Notifications → Webhooks');
console.log('4. Click on any webhook to see the signing secret\n');

// .env 파일 체크
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const webhookSecretLine = envContent.split('\n').find(line => line.startsWith('SHOPIFY_WEBHOOK_SECRET='));
  
  if (webhookSecretLine) {
    console.log('✅ SHOPIFY_WEBHOOK_SECRET is set in .env');
    const secretValue = webhookSecretLine.split('=')[1].replace(/["']/g, '');
    console.log(`   Value: ${secretValue.substring(0, 20)}...`);
  } else {
    console.log('❌ SHOPIFY_WEBHOOK_SECRET is NOT set in .env');
    console.log('   Add: SHOPIFY_WEBHOOK_SECRET="your-webhook-secret"');
  }
}

// 실제 Shopify 웹훅 시뮬레이션
console.log('\n\n🧪 Simulating Shopify webhook request to local server...\n');

const axios = require('axios');

async function simulateWebhook() {
  try {
    const response = await axios.post(
      `${config.middlewareBaseUrl}/webhooks/orders/create`,
      testBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Hmac-Sha256': hash,
          'X-Shopify-Topic': 'orders/create',
          'X-Shopify-Shop-Domain': config.shopify.shopDomain
        }
      }
    );
    
    console.log('✅ Webhook simulation successful!');
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, response.data);
  } catch (error) {
    if (error.response) {
      console.log(`❌ Webhook simulation failed!`);
      console.log(`   Status: ${error.response.status}`);
      console.log(`   Response: ${error.response.data}`);
      
      if (error.response.status === 401) {
        console.log('\n   🔍 401 Unauthorized means HMAC verification failed');
        console.log('   Check the webhook secret configuration');
      }
    } else {
      console.log(`❌ Request failed: ${error.message}`);
    }
  }
}

// ngrok URL이 설정되어 있으면 시뮬레이션 실행
if (config.middlewareBaseUrl && config.middlewareBaseUrl.includes('ngrok')) {
  simulateWebhook();
} else {
  console.log('⚠️  No ngrok URL found. Start ngrok and update MIDDLEWARE_BASE_URL in .env');
}