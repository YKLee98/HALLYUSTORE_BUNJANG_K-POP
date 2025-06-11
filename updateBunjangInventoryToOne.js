// scripts/updateBunjangInventoryToOne.js

require('dotenv').config();
const { shopifyGraphqlRequest, updateInventoryLevel } = require('../services/shopifyService');
const logger = require('../config/logger');

// BUNJANG 컬렉션 ID (catalogService.js에서 가져온 값)
const BUNJANG_COLLECTION_GID = 'gid://shopify/Collection/445888299257';
const INVENTORY_QUANTITY = 1;

async function updateAllBunjangProductsInventory() {
  const locationId = process.env.SHOPIFY_DEFAULT_LOCATION_ID;
  
  if (!locationId) {
    console.error('❌ SHOPIFY_LOCATION_ID가 .env 파일에 설정되지 않았습니다.');
    console.log('다음 단계를 따라주세요:');
    console.log('1. Shopify Admin > Settings > Locations 이동');
    console.log('2. 기본 위치 클릭');
    console.log('3. URL에서 ID 확인: /admin/settings/locations/12345678');
    console.log('4. .env 파일에 추가: SHOPIFY_LOCATION_ID=12345678');
    process.exit(1);
  }

  console.log('🚀 BUNJANG 컬렉션 재고 업데이트 시작...');
  console.log(`📍 Location ID: ${locationId}`);
  console.log(`📦 설정할 재고 수량: ${INVENTORY_QUANTITY}`);
  console.log('⏳ 시간이 걸릴 수 있습니다...\n');

  try {
    let hasNextPage = true;
    let cursor = null;
    let totalProducts = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    while (hasNextPage) {
      // BUNJANG 컬렉션의 상품 조회
      const query = `
        query getCollectionProducts($id: ID!, $first: Int!, $after: String) {
          collection(id: $id) {
            title
            products(first: $first, after: $after) {
              edges {
                node {
                  id
                  title
                  status
                  totalInventory
                  variants(first: 10) {
                    edges {
                      node {
                        id
                        sku
                        inventoryItem {
                          id
                        }
                        inventoryQuantity
                      }
                    }
                  }
                }
                cursor
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      `;

      const variables = {
        id: BUNJANG_COLLECTION_GID,
        first: 50,
        after: cursor
      };

      console.log(`📄 페이지 조회 중... (cursor: ${cursor || 'start'})`);
      const response = await shopifyGraphqlRequest(query, variables);

      if (!response.data?.collection) {
        console.error('❌ BUNJANG 컬렉션을 찾을 수 없습니다.');
        process.exit(1);
      }

      const collection = response.data.collection;
      const products = collection.products.edges || [];
      hasNextPage = collection.products.pageInfo.hasNextPage;

      console.log(`\n📋 ${collection.title} - ${products.length}개 상품 처리 중...`);

      // 각 상품의 재고 업데이트
      for (const { node: product, cursor: productCursor } of products) {
        cursor = productCursor;
        totalProducts++;

        // ACTIVE 상태가 아닌 상품은 건너뛰기
        if (product.status !== 'ACTIVE') {
          console.log(`⏭️  건너뛰기 (비활성): ${product.title}`);
          skippedCount++;
          continue;
        }

        console.log(`\n🔄 처리 중: ${product.title}`);
        console.log(`   현재 총 재고: ${product.totalInventory}`);

        // 각 variant의 재고 업데이트
        let productUpdated = false;
        for (const { node: variant } of product.variants.edges) {
          if (!variant.inventoryItem?.id) {
            console.log(`   ⚠️  Variant ${variant.id} (SKU: ${variant.sku})는 재고 관리가 비활성화되어 있습니다.`);
            continue;
          }

          // 이미 재고가 1인 경우 건너뛰기
          if (variant.inventoryQuantity === INVENTORY_QUANTITY) {
            console.log(`   ✓ Variant ${variant.sku}: 이미 재고가 ${INVENTORY_QUANTITY}개입니다.`);
            continue;
          }

          try {
            await updateInventoryLevel(
              variant.inventoryItem.id,
              locationId,
              INVENTORY_QUANTITY
            );
            
            console.log(`   ✅ Variant ${variant.sku}: 재고를 ${variant.inventoryQuantity} → ${INVENTORY_QUANTITY}로 업데이트`);
            productUpdated = true;
          } catch (error) {
            console.error(`   ❌ Variant ${variant.sku} 업데이트 실패:`, error.message);
            errorCount++;
          }
        }

        if (productUpdated) {
          updatedCount++;
        }

        // Rate limit 방지를 위한 딜레이
        if (totalProducts % 10 === 0) {
          console.log(`\n⏸️  Rate limit 방지를 위해 1초 대기...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`\n✅ 페이지 완료. 진행 상황: ${totalProducts}개 상품 처리됨`);
    }

    // 최종 결과 출력
    console.log('\n' + '='.repeat(50));
    console.log('📊 BUNJANG 재고 업데이트 완료!');
    console.log('='.repeat(50));
    console.log(`총 상품 수: ${totalProducts}`);
    console.log(`✅ 업데이트됨: ${updatedCount}`);
    console.log(`⏭️  건너뛰어짐: ${skippedCount}`);
    console.log(`❌ 오류: ${errorCount}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('\n❌ 재고 업데이트 중 오류 발생:', error);
    if (error.networkError) {
      console.error('네트워크 오류:', error.networkError);
    }
    if (error.graphQLErrors) {
      console.error('GraphQL 오류:', error.graphQLErrors);
    }
    process.exit(1);
  }
}

// 재고 업데이트만 하는 간단한 버전
async function quickUpdateInventory() {
  const locationId =  process.env.SHOPIFY_DEFAULT_LOCATION_ID;
  
  if (!locationId) {
    console.error('❌ SHOPIFY_LOCATION_ID가 설정되지 않았습니다.');
    return;
  }

  console.log('🚀 빠른 재고 업데이트 모드...');

  const query = `
    query getBunjangProducts($first: Int!, $after: String) {
      products(first: $first, after: $after, query: "collection_id:445888299257 AND status:active") {
        edges {
          node {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  inventoryItem {
                    id
                  }
                  inventoryQuantity
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor = null;
  let count = 0;

  while (hasNextPage) {
    const response = await shopifyGraphqlRequest(query, { first: 250, after: cursor });
    const products = response.data?.products?.edges || [];
    hasNextPage = response.data?.products?.pageInfo?.hasNextPage || false;

    for (const { node: product, cursor: productCursor } of products) {
      cursor = productCursor;
      const variant = product.variants.edges[0]?.node;
      
      if (variant?.inventoryItem?.id && variant.inventoryQuantity !== INVENTORY_QUANTITY) {
        try {
          await updateInventoryLevel(variant.inventoryItem.id, locationId, INVENTORY_QUANTITY);
          count++;
          console.log(`✅ ${count}. ${product.title}`);
        } catch (error) {
          console.error(`❌ 실패: ${product.title}`, error.message);
        }
      }
    }
  }

  console.log(`\n✅ 완료! 총 ${count}개 상품 업데이트됨`);
}

// 메인 실행
async function main() {
  console.log('BUNJANG 재고 업데이트 스크립트');
  console.log('================================\n');

  const args = process.argv.slice(2);
  const isQuickMode = args.includes('--quick') || args.includes('-q');

  if (isQuickMode) {
    await quickUpdateInventory();
  } else {
    await updateAllBunjangProductsInventory();
  }
}

// 스크립트 실행
main().catch(error => {
  console.error('치명적 오류:', error);
  process.exit(1);
});

/**
 * 사용법:
 * 
 * 1. 일반 모드 (상세 정보 표시):
 *    node scripts/updateBunjangInventoryToOne.js
 * 
 * 2. 빠른 모드:
 *    node scripts/updateBunjangInventoryToOne.js --quick
 * 
 * 필수 환경 변수:
 * - SHOPIFY_LOCATION_ID: Shopify 재고 위치 ID
 */