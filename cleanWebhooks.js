// cleanAndRegisterWebhooks.js
// 모든 웹훅을 삭제하고 올바른 경로로 재등록하는 스크립트

const axios = require('axios');
const config = require('./src/config');

const WEBHOOK_BASE_URL = process.env.MIDDLEWARE_BASE_URL

async function cleanAndRegisterWebhooks() {
  console.log('🧹 Cleaning and re-registering webhooks...\n');
  console.log(`📍 Base URL: ${WEBHOOK_BASE_URL}`);
  console.log(`🏪 Shop: ${config.shopify.shopDomain}\n`);

  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks.json`;
  
  try {
    // 1. 모든 기존 웹훅 삭제
    console.log('Step 1: Deleting all existing webhooks...\n');
    
    const listResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken,
        'Content-Type': 'application/json'
      }
    });
    
    const existingWebhooks = listResponse.data.webhooks || [];
    console.log(`Found ${existingWebhooks.length} existing webhooks to delete:\n`);
    
    for (const webhook of existingWebhooks) {
      console.log(`🗑️  Deleting: ${webhook.topic} (${webhook.address})`);
      try {
        await axios.delete(
          `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks/${webhook.id}.json`,
          {
            headers: {
              'X-Shopify-Access-Token': config.shopify.adminAccessToken
            }
          }
        );
        console.log(`   ✅ Deleted successfully\n`);
      } catch (error) {
        console.error(`   ❌ Failed to delete: ${error.message}\n`);
      }
    }
    
    console.log('✅ All webhooks deleted\n');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ Error while deleting webhooks:', error.message);
    return;
  }
    console.log('='.repeat(60));
}

cleanAndRegisterWebhooks()