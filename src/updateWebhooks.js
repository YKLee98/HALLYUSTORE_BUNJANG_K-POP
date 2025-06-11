// updateWebhooks.js
// 올바른 경로로 Shopify 웹훅을 다시 등록하는 스크립트

const axios = require('axios');
const config = require('./src/config');

async function updateWebhooks() {
  console.log('🔄 Updating webhook URLs...');
  console.log(`Base URL: ${config.middlewareBaseUrl || 'https://your-ngrok-url.ngrok-free.app'}`);
  console.log(`Shop Domain: ${config.shopify.shopDomain}`);
  
  // 먼저 기존 웹훅 삭제
  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks.json`;
  
  try {
    // 현재 등록된 웹훅 목록 가져오기
    console.log('\n📋 Fetching existing webhooks...');
    const listResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    const existingWebhooks = listResponse.data.webhooks;
    console.log(`Found ${existingWebhooks.length} existing webhooks`);
    
    // 잘못된 경로의 웹훅 삭제
    for (const webhook of existingWebhooks) {
      if (webhook.address.includes('/webhooks/orders/')) {
        console.log(`\n🗑️  Deleting webhook: ${webhook.topic} (${webhook.address})`);
        try {
          await axios.delete(
            `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks/${webhook.id}.json`,
            {
              headers: {
                'X-Shopify-Access-Token': config.shopify.adminAccessToken
              }
            }
          );
          console.log(`✅ Deleted webhook ${webhook.id}`);
        } catch (deleteError) {
          console.error(`❌ Failed to delete webhook ${webhook.id}:`, deleteError.message);
        }
      }
    }
    
  } catch (error) {
    console.error('Failed to list/delete webhooks:', error.message);
  }
  
  // 올바른 경로로 새 웹훅 등록
  const webhooks = [
    {
      topic: 'orders/create',
      address: `${config.middlewareBaseUrl || 'https://your-ngrok-url.ngrok-free.app'}/webhooks/shopify/orders/create`,
      format: 'json'
    },
    {
      topic: 'orders/updated', 
      address: `${config.middlewareBaseUrl || 'https://your-ngrok-url.ngrok-free.app'}/webhooks/shopify/orders/updated`,
      format: 'json'
    },
    {
      topic: 'orders/cancelled',
      address: `${config.middlewareBaseUrl || 'https://your-ngrok-url.ngrok-free.app'}/webhooks/shopify/orders/cancelled`,
      format: 'json'
    }
  ];
  
  console.log('\n📝 Registering new webhooks with correct paths...');
  
  for (const webhook of webhooks) {
    try {
      console.log(`\n🔗 Registering webhook: ${webhook.topic}`);
      console.log(`   Address: ${webhook.address}`);
      
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
      
    } catch (error) {
      console.error(`❌ Failed to register webhook ${webhook.topic}:`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Error: ${JSON.stringify(error.response.data, null, 2)}`);
      } else {
        console.error(`   Error: ${error.message}`);
      }
    }
  }
  
  // 최종 확인
  console.log('\n\n=== Final webhook configuration ===');
  try {
    const finalResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    console.log(`\n✅ Total webhooks registered: ${finalResponse.data.webhooks.length}`);
    finalResponse.data.webhooks.forEach(webhook => {
      console.log(`\n📌 ${webhook.topic}`);
      console.log(`   Address: ${webhook.address}`);
      console.log(`   Status: Active`);
    });
    
  } catch (error) {
    console.error('Failed to verify webhooks:', error.message);
  }
}

// 실행
updateWebhooks().then(() => {
  console.log('\n✅ Webhook update completed!');
  console.log('\n💡 Next steps:');
  console.log('1. Make sure your app is running');
  console.log('2. Check ngrok logs to see incoming requests');
  console.log('3. Create a test order in Shopify to verify');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Webhook update failed:', error);
  process.exit(1);
});