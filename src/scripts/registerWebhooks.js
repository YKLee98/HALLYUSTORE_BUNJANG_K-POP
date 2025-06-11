// src/scripts/registerWebhooks.js
// Shopify 웹훅을 수동으로 등록하는 스크립트

const axios = require('axios');
const config = require('../config');
const logger = require('../config/logger');

async function registerWebhooks() {
  console.log('Starting webhook registration...');
  console.log(`Middleware URL: ${config.middlewareBaseUrl}`);
  console.log(`Shop Domain: ${config.shopify.shopDomain}`);
  
  const webhooks = [
    {
      topic: 'orders/create',
      address: `${config.middlewareBaseUrl}/webhooks/orders/create`,
      format: 'json'
    },
    {
      topic: 'orders/updated', 
      address: `${config.middlewareBaseUrl}/webhooks/orders/updated`,
      format: 'json'
    },
    {
      topic: 'orders/cancelled',
      address: `${config.middlewareBaseUrl}/webhooks/orders/cancelled`,
      format: 'json'
    },
    {
      topic: 'orders/fulfilled',
      address: `${config.middlewareBaseUrl}/webhooks/orders/fulfilled`,
      format: 'json'
    }
  ];

  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/webhooks.json`;
  
  for (const webhook of webhooks) {
    try {
      console.log(`\nRegistering webhook: ${webhook.topic}`);
      console.log(`Webhook address: ${webhook.address}`);
      
      const response = await axios.post(
        shopifyApiUrl,
        { webhook },
        {
          headers: {
            'X-Shopify-Access-Token': config.shopify.adminAccessToken,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ Successfully registered webhook: ${webhook.topic}`);
      console.log(`   Webhook ID: ${response.data.webhook.id}`);
      console.log(`   Created at: ${response.data.webhook.created_at}`);
      
    } catch (error) {
      console.error(`❌ Failed to register webhook ${webhook.topic}:`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Error: ${JSON.stringify(error.response.data, null, 2)}`);
        
        // 이미 등록된 경우 처리
        if (error.response.status === 422 && error.response.data.errors?.address?.[0]?.includes('already taken')) {
          console.log(`   ℹ️  Webhook already exists for ${webhook.topic}`);
        }
      } else {
        console.error(`   Error: ${error.message}`);
      }
    }
  }
  
  // 등록된 웹훅 목록 확인
  console.log('\n\n=== Verifying registered webhooks ===');
  try {
    const listResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    console.log(`\nTotal webhooks registered: ${listResponse.data.webhooks.length}`);
    listResponse.data.webhooks.forEach(webhook => {
      console.log(`\n- Topic: ${webhook.topic}`);
      console.log(`  ID: ${webhook.id}`);
      console.log(`  Address: ${webhook.address}`);
      console.log(`  Created: ${webhook.created_at}`);
      console.log(`  Updated: ${webhook.updated_at}`);
    });
    
  } catch (error) {
    console.error('Failed to list webhooks:', error.message);
  }
}

// MongoDB 연결 없이 실행
registerWebhooks().then(() => {
  console.log('\n✅ Webhook registration process completed');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Webhook registration failed:', error);
  process.exit(1);
});