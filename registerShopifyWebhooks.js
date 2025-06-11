// registerShopifyWebhooks.js
// Shopify 웹훅을 등록하는 스크립트

const axios = require('axios');
const config = require('./src/config');
const logger = require('./src/config/logger');

// ngrok URL 또는 실제 서버 URL을 여기에 설정
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || config.middlewareBaseUrl || 'https://your-ngrok-url.ngrok-free.app';

async function registerWebhooks() {
  console.log('🚀 Starting Shopify webhook registration...');
  console.log(`📍 Webhook Base URL: ${WEBHOOK_BASE_URL}`);
  console.log(`🏪 Shop Domain: ${config.shopify.shopDomain}`);
  console.log(`🔑 API Version: ${config.shopify.apiVersion || '2025-04'}\n`);

  // Shopify Admin API URL
  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks.json`;
  
  // 등록할 웹훅 목록
  const webhooks = [
    {
      topic: 'orders/create',
      address: `${WEBHOOK_BASE_URL}/webhooks/orders/create`,
      format: 'json'
    },
    {
      topic: 'orders/updated', 
      address: `${WEBHOOK_BASE_URL}/webhooks/orders/updated`,
      format: 'json'
    },
    {
      topic: 'orders/cancelled',
      address: `${WEBHOOK_BASE_URL}/webhooks/orders/cancelled`,
      format: 'json'
    },
    {
      topic: 'orders/fulfilled',
      address: `${WEBHOOK_BASE_URL}/webhooks/orders/fulfilled`,
      format: 'json'
    }
  ];

  // 먼저 기존 웹훅 목록 확인
  try {
    console.log('📋 Checking existing webhooks...\n');
    const listResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken,
        'Content-Type': 'application/json'
      }
    });
    
    const existingWebhooks = listResponse.data.webhooks || [];
    
    if (existingWebhooks.length > 0) {
      console.log(`Found ${existingWebhooks.length} existing webhooks:`);
      existingWebhooks.forEach(webhook => {
        console.log(`  - ${webhook.topic}: ${webhook.address}`);
      });
      console.log('');
      
      // 중복된 웹훅 삭제 옵션
      const duplicates = existingWebhooks.filter(existing => 
        webhooks.some(newWebhook => 
          existing.topic === newWebhook.topic && 
          existing.address !== newWebhook.address
        )
      );
      
      if (duplicates.length > 0) {
        console.log(`🗑️  Found ${duplicates.length} duplicate webhooks to remove...\n`);
        
        for (const duplicate of duplicates) {
          try {
            await axios.delete(
              `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks/${duplicate.id}.json`,
              {
                headers: {
                  'X-Shopify-Access-Token': config.shopify.adminAccessToken
                }
              }
            );
            console.log(`✅ Deleted duplicate webhook: ${duplicate.topic} (${duplicate.id})`);
          } catch (deleteError) {
            console.error(`❌ Failed to delete webhook ${duplicate.id}:`, deleteError.message);
          }
        }
        console.log('');
      }
    }
    
  } catch (error) {
    console.error('❌ Failed to list existing webhooks:', error.message);
  }

  // 새 웹훅 등록
  console.log('📝 Registering webhooks...\n');
  const results = {
    success: [],
    failed: [],
    skipped: []
  };

  for (const webhook of webhooks) {
    try {
      console.log(`🔗 Registering: ${webhook.topic}`);
      console.log(`   URL: ${webhook.address}`);
      
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
      
      console.log(`✅ Success! Webhook ID: ${response.data.webhook.id}\n`);
      results.success.push(webhook.topic);
      
    } catch (error) {
      if (error.response?.status === 422 && 
          error.response?.data?.errors?.address?.[0]?.includes('already taken')) {
        console.log(`⏭️  Skipped (already exists)\n`);
        results.skipped.push(webhook.topic);
      } else {
        console.error(`❌ Failed!`);
        console.error(`   Status: ${error.response?.status || 'N/A'}`);
        console.error(`   Error: ${JSON.stringify(error.response?.data || error.message, null, 2)}\n`);
        results.failed.push(webhook.topic);
      }
    }
  }

  // 최종 결과 확인
  console.log('\n' + '='.repeat(60));
  console.log('📊 Registration Summary:');
  console.log('='.repeat(60));
  console.log(`✅ Successfully registered: ${results.success.length}`);
  if (results.success.length > 0) {
    results.success.forEach(topic => console.log(`   - ${topic}`));
  }
  
  console.log(`⏭️  Already existed: ${results.skipped.length}`);
  if (results.skipped.length > 0) {
    results.skipped.forEach(topic => console.log(`   - ${topic}`));
  }
  
  console.log(`❌ Failed: ${results.failed.length}`);
  if (results.failed.length > 0) {
    results.failed.forEach(topic => console.log(`   - ${topic}`));
  }
  
  // 현재 활성 웹훅 목록
  console.log('\n' + '='.repeat(60));
  console.log('📌 Current Active Webhooks:');
  console.log('='.repeat(60));
  
  try {
    const finalResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    const activeWebhooks = finalResponse.data.webhooks || [];
    activeWebhooks.forEach((webhook, index) => {
      console.log(`\n${index + 1}. ${webhook.topic}`);
      console.log(`   ID: ${webhook.id}`);
      console.log(`   URL: ${webhook.address}`);
      console.log(`   Created: ${webhook.created_at}`);
      console.log(`   Updated: ${webhook.updated_at}`);
    });
    
  } catch (error) {
    console.error('Failed to fetch final webhook list:', error.message);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Webhook registration completed!');
  console.log('='.repeat(60));
  console.log('\n💡 Next steps:');
  console.log('1. Make sure your app is running');
  console.log('2. Check ngrok/server logs for incoming webhook requests');
  console.log('3. Create a test order in Shopify to verify webhook functionality');
  console.log(`4. Monitor logs: pm2 logs or tail -f logs/app.log`);
}

// 웹훅 삭제 함수 (필요시 사용)
async function deleteAllWebhooks() {
  console.log('🗑️  Deleting all webhooks...\n');
  
  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks.json`;
  
  try {
    const response = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    const webhooks = response.data.webhooks || [];
    
    for (const webhook of webhooks) {
      try {
        await axios.delete(
          `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks/${webhook.id}.json`,
          {
            headers: {
              'X-Shopify-Access-Token': config.shopify.adminAccessToken
            }
          }
        );
        console.log(`✅ Deleted: ${webhook.topic} (${webhook.id})`);
      } catch (error) {
        console.error(`❌ Failed to delete ${webhook.topic}:`, error.message);
      }
    }
    
    console.log('\n✅ All webhooks deleted');
    
  } catch (error) {
    console.error('❌ Failed to delete webhooks:', error.message);
  }
}

// 명령줄 인자 처리
const args = process.argv.slice(2);

if (args[0] === 'delete') {
  // 모든 웹훅 삭제
  deleteAllWebhooks().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  // 웹훅 등록
  registerWebhooks().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}