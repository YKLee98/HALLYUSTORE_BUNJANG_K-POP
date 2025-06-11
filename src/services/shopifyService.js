// src/services/shopifyService.js

// Import the Node adapter FIRST to make platform-specific functions available
require('@shopify/shopify-api/adapters/node');

const {
    shopifyApi,
    ApiVersion,
    GraphqlQueryError,
    BillingInterval,
    LATEST_API_VERSION
} = require('@shopify/shopify-api');

const config = require('../config');
const logger = require('../config/logger');
const { ExternalServiceError, AppError, NotFoundError, ValidationError } = require('../utils/customErrors');

const SERVICE_NAME = 'ShopifySvc';

// BunJang Warehouse 상수 - 절대 변경하지 않음
const BUNJANG_WAREHOUSE_GID = 'gid://shopify/Location/82604261625';
const BUNJANG_WAREHOUSE_ID = '82604261625';

// 환경 변수 디버깅 - 실제 로드된 값 확인
logger.info(`[${SERVICE_NAME}] Environment variables check at startup:`, {
  SHOPIFY_DEFAULT_LOCATION_ID_ENV: process.env.SHOPIFY_DEFAULT_LOCATION_ID,
  configDefaultLocationId: config.shopify?.defaultLocationId,
  nodeEnv: process.env.NODE_ENV
});

// 환경 변수에서 직접 읽기 - 캐싱 방지 및 형식 변환
function getDefaultLocationId() {
  // BunJang Warehouse ID를 직접 반환
  const locationId = BUNJANG_WAREHOUSE_ID;
  
  logger.info(`[${SERVICE_NAME}] Using BunJang Warehouse location ID: ${locationId}`);
  
  // 이미 GID 형식이면 그대로 사용
  if (locationId.startsWith('gid://shopify/Location/')) {
    return locationId;
  }
  
  // 숫자형 ID면 GID 형식으로 변환
  if (/^\d+$/.test(locationId)) {
    const gid = `gid://shopify/Location/${locationId}`;
    logger.debug(`[${SERVICE_NAME}] Converting numeric location ID to GID: ${locationId} -> ${gid}`);
    return gid;
  }
  
  // 기본값 사용
  logger.warn(`[${SERVICE_NAME}] Invalid location ID format: ${locationId}. Using default.`);
  return BUNJANG_WAREHOUSE_GID;
}

let shopify;

try {
    let apiVersionEnum;
    const configuredApiVersionString = config.shopify.apiVersion;

    if (!configuredApiVersionString) {
        logger.warn(`[${SERVICE_NAME}] Shopify API version not set in config.shopify.apiVersion. Defaulting to LATEST_API_VERSION.`);
        apiVersionEnum = LATEST_API_VERSION;
    } else if (configuredApiVersionString.toUpperCase() === 'LATEST') {
        apiVersionEnum = LATEST_API_VERSION;
    } else if (ApiVersion[configuredApiVersionString]) {
        apiVersionEnum = ApiVersion[configuredApiVersionString];
    } else {
        let parsedVersionKey = configuredApiVersionString;
        const match = configuredApiVersionString.match(/^(\d{4})-(\d{2})$/);

        if (match) {
            const year = match[1].substring(2);
            const monthIndex = parseInt(match[2], 10) - 1;
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            
            if (monthIndex >= 0 && monthIndex < 12) {
                parsedVersionKey = monthNames[monthIndex] + year;
            } else {
                logger.warn(`[${SERVICE_NAME}] Invalid month in configured Shopify API version "${configuredApiVersionString}".`);
                parsedVersionKey = configuredApiVersionString;
            }
        }

        if (ApiVersion[parsedVersionKey]) {
            apiVersionEnum = ApiVersion[parsedVersionKey];
        } else {
            const availableVersions = Object.keys(ApiVersion).filter(k => /^[A-Z][a-z]+(2\d|Unstable)$/.test(k)).join(', ');
            logger.warn(`[${SERVICE_NAME}] Configured Shopify API version "${configuredApiVersionString}" (parsed as "${parsedVersionKey}") is not available in the installed @shopify/shopify-api library. Available versions: ${availableVersions}. Defaulting to LATEST_API_VERSION.`);
            apiVersionEnum = LATEST_API_VERSION;
        }
    }
    
    shopify = shopifyApi({
        apiKey: config.shopify.apiKey,
        apiSecretKey: config.shopify.apiSecret,
        scopes: Array.isArray(config.shopify.apiScopes) ? config.shopify.apiScopes : config.shopify.apiScopes.split(','),
        hostName: config.shopify.shopDomain.replace(/^https?:\/\//, '').split('/')[0],
        apiVersion: apiVersionEnum,
        isEmbeddedApp: config.shopify.isEmbeddedApp !== undefined ? config.shopify.isEmbeddedApp : false,
    });

    const actualInitializedApiVersion = shopify.config.apiVersion;
    const apiVersionName = Object.keys(ApiVersion).find(key => ApiVersion[key] === actualInitializedApiVersion) || actualInitializedApiVersion.toString();
    logger.info(`[${SERVICE_NAME}] Shopify API client initialized successfully. Host: ${shopify.config.hostName}, API Version: ${apiVersionName}. (Configured: ${configuredApiVersionString})`);

} catch (error) {
    logger.error(`[${SERVICE_NAME}] CRITICAL: Failed to initialize Shopify API client: ${error.message}`, {
        errorMessage: error.message,
        stack: error.stack,
        details: error.cause
    });
    throw new AppError(`Shopify API library initialization failed: ${error.message}`, 500, 'SHOPIFY_LIB_INIT_FAILURE', { cause: error });
}

function getShopifyAdminGraphQLClient() {
  if (!shopify) {
    logger.error(`[${SERVICE_NAME}] Shopify client instance is not available. Initialization might have failed.`);
    throw new AppError('Failed to create Shopify GraphQL client. Shopify instance not initialized.', 500, 'SHOPIFY_CLIENT_INSTANCE_FAILURE');
  }

  const shopHostname = String(config.shopify.shopDomain || '').replace(/^https?:\/\//, '').split('/')[0];
  const tokenValue = config.shopify.adminAccessToken;
  const tokenPreview = String(tokenValue || '').substring(0, 15);

  logger.debug(
    `[${SERVICE_NAME}] Preparing to create GraphQL client. Shop: '${shopHostname}', ` +
    `Admin Access Token Type: ${typeof tokenValue}, ` +
    `Token starts with: '${tokenPreview}${String(tokenValue || '').length > 15 ? '...' : ''}'`
  );
  
  if (!tokenValue || typeof tokenValue !== 'string' || !tokenValue.startsWith('shpat_')) {
    logger.error(`[${SERVICE_NAME}] CRITICAL: Shopify Admin Access Token is invalid or missing. Type: ${typeof tokenValue}, Value Preview: '${tokenPreview}...'.`);
    throw new AppError('Shopify Admin Access Token is invalid or not set.', 500, 'SHOPIFY_TOKEN_INVALID');
  }

  if (!shopHostname || !shopHostname.includes('.myshopify.com')) {
    logger.error(`[${SERVICE_NAME}] CRITICAL: Shopify shop domain ('${shopHostname}') is invalid.`);
    throw new AppError('Shopify store domain is invalid.', 500, 'SHOPIFY_DOMAIN_INVALID');
  }

  try {
    let session;
    if (shopify.session?.customAppSession) {
        session = shopify.session.customAppSession(shopHostname);
    } else if (shopify.Session?.CustomAppSession) {
        session = shopify.Session.CustomAppSession(shopHostname);
    } else {
        logger.error(`[${SERVICE_NAME}] CRITICAL: shopify.session.customAppSession (or Shopify.Session.CustomAppSession) is not available on the Shopify API instance.`);
        throw new AppError('Cannot create Shopify session object. Library initialization error possible.', 500, 'SHOPIFY_SESSION_ERROR');
    }
    
    session.accessToken = tokenValue;
    session.shop = shopHostname;

    logger.debug(`[${SERVICE_NAME}] Custom app session created for shop: '${session.shop}', accessToken is ${session.accessToken ? 'set on session' : 'NOT set on session'}.`);
    return new shopify.clients.Graphql({ session });

  } catch (clientCreationError) {
    logger.error(`[${SERVICE_NAME}] Error creating Shopify GraphQL client with explicit session: ${clientCreationError.message}`, { stack: clientCreationError.stack });
    throw new AppError(`Error creating Shopify GraphQL client: ${clientCreationError.message}`, 500, 'SHOPIFY_CLIENT_CREATION_EXPLICIT_SESSION_ERROR', { cause: clientCreationError });
  }
}

const MAX_SHOPIFY_RETRIES = parseInt(process.env.SHOPIFY_API_MAX_RETRIES, 10) || 3;
const INITIAL_SHOPIFY_RETRY_DELAY_MS = parseInt(process.env.SHOPIFY_API_INITIAL_RETRY_DELAY_MS, 10) || 2000;
const JITTER_FACTOR = 0.3;

async function shopifyGraphqlRequest(query, variables = {}) {
  const client = getShopifyAdminGraphQLClient();
  const operationName = query.match(/(query|mutation)\s+(\w+)/)?.[2] || 'UnnamedOperation';

  for (let attempt = 0; attempt <= MAX_SHOPIFY_RETRIES; attempt++) {
    try {
      logger.debug(`[${SERVICE_NAME}] GraphQL operation attempt ${attempt + 1}/${MAX_SHOPIFY_RETRIES + 1}: ${operationName}`, { 
        variables: Object.keys(variables),
        variableValues: JSON.stringify(variables)
      });
      
      // request 메소드는 query를 첫 번째 파라미터로, options를 두 번째 파라미터로 받습니다
      let response;
      try {
        response = await client.request(query, {
          variables: variables,
          // tries가 아닌 retries 사용 (API v12.0.0 변경사항)
          retries: 2
        });
      } catch (requestError) {
        // request 메소드 실패 시 상세 에러 로깅
        logger.error(`[${SERVICE_NAME}] Request method failed:`, {
          error: requestError.message,
          stack: requestError.stack,
          query: query.substring(0, 200),
          variables: variables
        });
        
        // 구문 에러나 잘못된 쿼리인 경우 재시도하지 않음
        if (requestError.message.includes('Syntax Error') || 
            requestError.message.includes('Invalid query')) {
          throw new ExternalServiceError(
            SERVICE_NAME, 
            requestError, 
            `GraphQL query syntax error for ${operationName}`,
            'GRAPHQL_SYNTAX_ERROR',
            { query: query.substring(0, 500), variables }
          );
        }
        
        throw requestError;
      }

      // response 구조가 변경됨: response.body가 아닌 response 직접 사용
      if (response.errors && response.errors.length > 0) {
        const errorDetails = {
          querySummary: query.substring(0, 250) + (query.length > 250 ? '...' : ''),
          variables,
          errors: response.errors,
          extensions: response.extensions,
          attempt: attempt + 1,
        };
        logger.error(`[${SERVICE_NAME}] GraphQL errors in response:`, errorDetails);
        throw new ExternalServiceError(
          SERVICE_NAME, 
          null, 
          `Shopify GraphQL API returned errors for ${operationName}.`, 
          'SHOPIFY_GQL_USER_ERRORS', 
          errorDetails
        );
      }
      
      // response.data가 null인 경우 처리
      if (response.data === null && query.trim().startsWith('mutation')) {
        logger.warn(`[${SERVICE_NAME}] GraphQL Mutation ${operationName} returned null data without errors. Response:`, response);
      }
      
      // request 메소드는 response.body가 아닌 response 자체를 반환
      return response;

    } catch (error) {
      if (error instanceof GraphqlQueryError) {
        const statusCode = error.response?.statusCode || error.statusCode;
        const isThrottled = statusCode === 429 || (error.message && error.message.toLowerCase().includes('throttled'));
        const isServerError = statusCode >= 500 && statusCode <= 599;
        
        const errorLogDetails = {
          message: error.message,
          operationName,
          querySummary: query.substring(0, 100) + '...',
          statusCode,
          isThrottled,
          isServerError,
          attempt: attempt + 1,
          responseBody: error.response?.body || error.body,
          stack: error.stack
        };
        logger.warn(`[${SERVICE_NAME}] GraphqlQueryError for ${operationName}:`, errorLogDetails);

        if (attempt < MAX_SHOPIFY_RETRIES && (isThrottled || isServerError)) {
          let delayMs = INITIAL_SHOPIFY_RETRY_DELAY_MS * Math.pow(2, attempt);
          const jitter = delayMs * JITTER_FACTOR * (Math.random() * 2 - 1);
          delayMs = Math.max(1000, Math.round(delayMs + jitter));
          
          if (isThrottled && error.response?.headers?.['retry-after']) {
            const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10);
            if (!isNaN(retryAfterSeconds)) {
              delayMs = Math.max(delayMs, retryAfterSeconds * 1000 + 500);
            }
          }
          
          logger.info(`[${SERVICE_NAME}] Retrying GraphQL operation ${operationName} after ${Math.round(delayMs / 1000)}s.`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        
        throw new ExternalServiceError(
          SERVICE_NAME, 
          error, 
          `Shopify API request failed (Operation: ${operationName}, Status: ${statusCode || 'N/A'})`
        );
      
      } else if (error instanceof ExternalServiceError || error instanceof AppError) {
        throw error;
      } else {
        // 예상치 못한 에러에 대한 상세 로깅
        logger.error(`[${SERVICE_NAME}] Unexpected error during Shopify GraphQL operation ${operationName} (Attempt ${attempt + 1}):`, {
          error: error.message,
          stack: error.stack,
          query: query.substring(0, 200),
          variables: JSON.stringify(variables)
        });
        
        // Status: N/A 에러를 더 명확하게 처리
        const errorMessage = error.message || 'Unknown error';
        const statusCode = error.statusCode || error.response?.statusCode || 'N/A';
        
        throw new ExternalServiceError(
          SERVICE_NAME, 
          error, 
          `Unexpected error during Shopify API call (Operation: ${operationName}, Status: ${statusCode}, Message: ${errorMessage})`
        );
      }
    }
  }
  
  throw new ExternalServiceError(
    SERVICE_NAME, 
    null, 
    `Shopify API request failed after all retries (Operation: ${operationName})`
  );
}

// Inventory를 location에 연결하는 함수 - 간소화
async function activateInventoryAtLocation(inventoryItemId, locationId) {
  // 항상 BunJang Warehouse GID 사용
  const gidLocationId = BUNJANG_WAREHOUSE_GID;
  
  logger.info(`[${SERVICE_NAME}] Activating inventory ${inventoryItemId} at BunJang Warehouse ${gidLocationId}`);
  
  // 먼저 현재 inventory level 확인
  const checkQuery = `
    query checkInventoryLevel($itemId: ID!) {
      inventoryItem(id: $itemId) {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              id
              location {
                id
                name
              }
              available
            }
          }
        }
      }
    }`;
  
  try {
    const checkResponse = await shopifyGraphqlRequest(checkQuery, { itemId: inventoryItemId });
    const levels = checkResponse.data?.inventoryItem?.inventoryLevels?.edges || [];
    
    // 이미 연결되어 있는지 확인
    const existingLevel = levels.find(edge => edge.node.location.id === gidLocationId);
    if (existingLevel) {
      logger.info(`[${SERVICE_NAME}] Inventory item ${inventoryItemId} already connected to BunJang Warehouse. Current quantity: ${existingLevel.node.available}`);
      return existingLevel.node;
    }
    
    // 연결되어 있지 않으면 activat
    const mutation = `
      mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          inventoryLevel {
            id
            available
            location {
              id
              name
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`;
    
    const response = await shopifyGraphqlRequest(mutation, {
      inventoryItemId,
      locationId: gidLocationId
    });
    
    if (response.data?.inventoryActivate?.userErrors?.length > 0) {
      const errors = response.data.inventoryActivate.userErrors;
      const errorMessage = errors.map(e => `${e.code}: ${e.message}`).join(', ');
      logger.error(`[${SERVICE_NAME}] Failed to activate inventory at location: ${errorMessage}`);
      throw new Error(`Failed to activate inventory: ${errorMessage}`);
    }
    
    const inventoryLevel = response.data?.inventoryActivate?.inventoryLevel;
    if (inventoryLevel) {
      logger.info(`[${SERVICE_NAME}] ✅ Successfully activated inventory at ${inventoryLevel.location.name} (${inventoryLevel.location.id})`);
    }
    
    return inventoryLevel;
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Error in activateInventoryAtLocation: ${error.message}`);
    throw error;
  }
}

// FIX: 재고 추적 활성화를 위한 새로운 함수
async function enableInventoryTracking(inventoryItemId) {
  const mutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          tracked
        }
        userErrors {
          field
          message
        }
      }
    }`;
  
  logger.info(`[${SERVICE_NAME}] Enabling inventory tracking for ${inventoryItemId}`);
  
  const response = await shopifyGraphqlRequest(mutation, {
    id: inventoryItemId,
    input: {
      tracked: true
    }
  });
  
  if (response.data?.inventoryItemUpdate?.userErrors?.length > 0) {
    const errorMessage = response.data.inventoryItemUpdate.userErrors.map(e => e.message).join(', ');
    logger.error(`[${SERVICE_NAME}] Failed to enable inventory tracking: ${errorMessage}`);
    throw new Error(`Failed to enable inventory tracking: ${errorMessage}`);
  }
  
  return response.data?.inventoryItemUpdate?.inventoryItem;
}

// FIX: 가격과 SKU 업데이트를 위한 productVariantsBulkUpdate 사용
async function updateVariantPriceAndSku(productId, variantId, price, sku) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          sku
        }
        userErrors {
          field
          message
        }
      }
    }`;
  
  const variants = [{
    id: variantId,
    price: String(price)
  }];
  
  logger.info(`[${SERVICE_NAME}] Updating variant ${variantId} price to ${price} using productVariantsBulkUpdate`);
  
  const response = await shopifyGraphqlRequest(mutation, { productId, variants });
  
  if (response.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
    const errorMessage = response.data.productVariantsBulkUpdate.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    logger.error(`[${SERVICE_NAME}] Failed to update variant price: ${errorMessage}`);
    throw new ExternalServiceError(SERVICE_NAME, null, `Variant price update failed: ${errorMessage}`, 'SHOPIFY_VARIANT_PRICE_UPDATE_ERROR');
  }
  
  const updatedVariant = response.data?.productVariantsBulkUpdate?.productVariants?.[0];
  logger.info(`[${SERVICE_NAME}] Successfully updated variant price to ${updatedVariant?.price}`);
  
  // SKU는 별도로 업데이트 (productVariantsBulkUpdate에서 SKU 지원 안함)
  if (sku) {
    await updateVariantSku(variantId, sku);
  }
  
  return updatedVariant;
}

// updateVariantSku 함수 - SKU만 업데이트
async function updateVariantSku(variantId, sku) {
  const mutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          sku
        }
        userErrors {
          field
          message
        }
      }
    }`;
  
  // 먼저 variant의 inventory item ID를 가져옴
  const variantQuery = `
    query getVariantInventoryItem($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
        }
      }
    }`;
  
  const variantResponse = await shopifyGraphqlRequest(variantQuery, { id: variantId });
  const inventoryItemId = variantResponse.data?.productVariant?.inventoryItem?.id;
  
  if (!inventoryItemId) {
    logger.error(`[${SERVICE_NAME}] No inventory item found for variant ${variantId}`);
    return null;
  }
  
  logger.info(`[${SERVICE_NAME}] Updating SKU for inventory item ${inventoryItemId} to ${sku}`);
  
  const response = await shopifyGraphqlRequest(mutation, {
    id: inventoryItemId,
    input: { sku: sku }
  });
  
  if (response.data?.inventoryItemUpdate?.userErrors?.length > 0) {
    const errorMessage = response.data.inventoryItemUpdate.userErrors.map(e => e.message).join(', ');
    logger.error(`[${SERVICE_NAME}] Failed to update SKU: ${errorMessage}`);
  }
  
  return response.data?.inventoryItemUpdate?.inventoryItem;
}

// FIX: 재고 정책 업데이트
async function updateVariantInventoryPolicy(productId, variantId, inventoryPolicy) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          inventoryPolicy
        }
        userErrors {
          field
          message
        }
      }
    }`;
  
  const variants = [{
    id: variantId,
    inventoryPolicy: inventoryPolicy
  }];
  
  logger.info(`[${SERVICE_NAME}] Updating variant ${variantId} inventory policy to ${inventoryPolicy}`);
  
  const response = await shopifyGraphqlRequest(mutation, { productId, variants });
  
  if (response.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
    const errorMessage = response.data.productVariantsBulkUpdate.userErrors.map(e => e.message).join(', ');
    logger.error(`[${SERVICE_NAME}] Failed to update inventory policy: ${errorMessage}`);
  }
  
  return response.data?.productVariantsBulkUpdate?.productVariants?.[0];
}

// 새로운 함수: variant 업데이트 시 재고 추적 활성화
async function updateVariantWithInventoryTracking(variantId, updateData) {
  // 먼저 variant 정보 가져오기
  const variantQuery = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
          tracked
        }
        product {
          id
        }
      }
    }`;
  
  const variantResponse = await shopifyGraphqlRequest(variantQuery, { id: variantId });
  const variant = variantResponse.data?.productVariant;
  
  if (!variant) {
    throw new Error(`Variant ${variantId} not found`);
  }
  
  const productId = variant.product.id;
  const inventoryItemId = variant.inventoryItem?.id;
  
  // 재고 추적 활성화
  if (inventoryItemId && !variant.inventoryItem.tracked) {
    await enableInventoryTracking(inventoryItemId);
  }
  
  // 가격 업데이트
  if (updateData.price) {
    await updateVariantPriceAndSku(productId, variantId, updateData.price, updateData.sku);
  } else if (updateData.sku) {
    await updateVariantSku(variantId, updateData.sku);
  }
  
  // 재고 정책 업데이트
  if (updateData.inventoryPolicy) {
    await updateVariantInventoryPolicy(productId, variantId, updateData.inventoryPolicy);
  }
  
  return variant;
}

async function createProduct(productInput, collectionGID = null, variantInfo = null) {
  // Remove media field if present (images are added separately)
  const { media, ...baseProductInput } = productInput;
  
  // Ensure product is set to ACTIVE status and published
  baseProductInput.status = 'ACTIVE';
  
  // Set publishedAt to make sure product is visible
  if (!baseProductInput.publishedAt) {
    baseProductInput.publishedAt = new Date().toISOString();
  }
  
  if (collectionGID) {
    baseProductInput.collectionsToJoin = [collectionGID];
  }

  // In API 2025-04, variants are NOT supported in ProductInput
  const mutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          descriptionHtml
          handle
          status
          publishedAt
          variants(first: 5) {
            edges {
              node {
                id
                sku
                price
                inventoryItem {
                  id
                  tracked
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`;
  
  logger.info(`[${SERVICE_NAME}] Attempting to create Shopify product:`, { 
    title: productInput.title, 
    status: baseProductInput.status,
    publishedAt: baseProductInput.publishedAt,
    collectionGID
  });
  
  const response = await shopifyGraphqlRequest(mutation, { input: baseProductInput });
  
  // response.data로 직접 접근 (response.body.data가 아님)
  if (response.data?.productCreate?.userErrors && response.data.productCreate.userErrors.length > 0) {
    const errorMessage = response.data.productCreate.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    throw new ExternalServiceError(SERVICE_NAME, null, `Product creation failed: ${errorMessage}`, 'SHOPIFY_PRODUCT_CREATE_ERROR', { userErrors: response.data.productCreate.userErrors });
  }
  
  const createdProduct = response.data?.productCreate?.product;
  
  if (!createdProduct) {
    throw new ExternalServiceError(SERVICE_NAME, null, 'Product creation returned null product', 'SHOPIFY_PRODUCT_CREATE_NULL');
  }
  
  logger.info(`[${SERVICE_NAME}] Successfully created Shopify product:`, { 
    id: createdProduct.id, 
    title: createdProduct.title,
    handle: createdProduct.handle,
    variantCount: createdProduct.variants?.edges?.length || 0
  });
  
  // Now update the default variant with price and inventory information
  if (variantInfo && createdProduct.variants?.edges?.length > 0) {
    const defaultVariant = createdProduct.variants.edges[0].node;
    const variantId = defaultVariant.id;
    const inventoryItemId = defaultVariant.inventoryItem?.id;
    const productId = createdProduct.id;
    
    try {
      logger.info(`[${SERVICE_NAME}] === SETTING UP NEW PRODUCT VARIANT ===`);
      logger.info(`[${SERVICE_NAME}] Product ID: ${productId}`);
      logger.info(`[${SERVICE_NAME}] Variant ID: ${variantId}`);
      logger.info(`[${SERVICE_NAME}] Inventory Item ID: ${inventoryItemId}`);
      
      // 1. 재고 추적 활성화
      if (inventoryItemId && !defaultVariant.inventoryItem?.tracked) {
        logger.info(`[${SERVICE_NAME}] Step 1: Enabling inventory tracking...`);
        await enableInventoryTracking(inventoryItemId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        logger.info(`[${SERVICE_NAME}] ✅ Inventory tracking enabled`);
      }
      
      // 2. 가격과 SKU 업데이트
      logger.info(`[${SERVICE_NAME}] Step 2: Updating price to ${variantInfo.price} and SKU to ${variantInfo.sku}...`);
      await updateVariantPriceAndSku(productId, variantId, variantInfo.price, variantInfo.sku);
      logger.info(`[${SERVICE_NAME}] ✅ Price and SKU updated`);
      
      // 3. 재고 정책 업데이트
      if (variantInfo.inventoryPolicy) {
        logger.info(`[${SERVICE_NAME}] Step 3: Updating inventory policy to ${variantInfo.inventoryPolicy}...`);
        await updateVariantInventoryPolicy(productId, variantId, variantInfo.inventoryPolicy);
        logger.info(`[${SERVICE_NAME}] ✅ Inventory policy updated`);
      }
      
      // 4. 재고 설정 - 항상 1로 설정
      if (inventoryItemId) {
        logger.info(`[${SERVICE_NAME}] Step 4: Setting inventory quantity to 1 at BunJang Warehouse...`);
        
        try {
          // updateInventoryLevel 함수 사용 - 항상 1로 설정
          await updateInventoryLevel(inventoryItemId, BUNJANG_WAREHOUSE_GID, 1);
          logger.info(`[${SERVICE_NAME}] ✅ Inventory successfully set to 1 at BunJang Warehouse`);
        } catch (invError) {
          logger.error(`[${SERVICE_NAME}] ❌ Failed to set inventory: ${invError.message}`);
          // 실패해도 계속 진행 (상품은 이미 생성됨)
        }
      }
      
      logger.info(`[${SERVICE_NAME}] === VARIANT SETUP COMPLETED ===`);
      
    } catch (variantError) {
      logger.error(`[${SERVICE_NAME}] Failed to update variant details after product creation: ${variantError.message}`);
      // Don't fail the entire operation - product is already created
    }
  }
  
  // Publish product to all available sales channels
  try {
    await publishProductToSalesChannels(createdProduct.id);
  } catch (publishError) {
    logger.error(`[${SERVICE_NAME}] Failed to publish product to sales channels: ${publishError.message}`);
    // Don't fail the entire operation
  }
  
  return createdProduct;
}

async function publishProductToSalesChannels(productId) {
  logger.info(`[${SERVICE_NAME}] Publishing product ${productId} to sales channels...`);
  
  // Get all available publications (sales channels)
  const pubQuery = `
    query {
      publications(first: 20) {
        edges {
          node {
            id
            name
            supportsFuturePublishing
          }
        }
      }
    }`;
  
  const pubResponse = await shopifyGraphqlRequest(pubQuery, {});
  const publications = pubResponse.data?.publications?.edges || [];
  
  logger.info(`[${SERVICE_NAME}] Found ${publications.length} sales channels`);
  
  // Find online store and any other active channels
  const channelsToPublish = publications.filter(pub => {
    const name = pub.node.name.toLowerCase();
    // Include online store and potentially other channels
    return name.includes('online store') || 
           name === 'online store' ||
           name.includes('온라인 스토어') ||
           name.includes('shop');
  });
  
  if (channelsToPublish.length > 0) {
    logger.info(`[${SERVICE_NAME}] Publishing to ${channelsToPublish.length} channels: ${channelsToPublish.map(ch => ch.node.name).join(', ')}`);
    
    // Use publishablePublish to add product to sales channels
    const publishMutation = `
      mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable {
            availablePublicationCount
            publicationCount
          }
          userErrors {
            field
            message
          }
        }
      }`;
    
    const publicationInputs = channelsToPublish.map(ch => ({
      publicationId: ch.node.id
    }));
    
    const publishResult = await shopifyGraphqlRequest(publishMutation, {
      id: productId,
      input: publicationInputs
    });
    
    if (publishResult.data?.publishablePublish?.userErrors?.length > 0) {
      logger.error(`[${SERVICE_NAME}] Errors publishing product:`, publishResult.data.publishablePublish.userErrors);
      throw new Error(`Publishing failed: ${publishResult.data.publishablePublish.userErrors.map(e => e.message).join(', ')}`);
    } else {
      const pubCount = publishResult.data?.publishablePublish?.publishable?.publicationCount || 0;
      logger.info(`[${SERVICE_NAME}] Product is now published to ${pubCount} sales channels`);
    }
  } else {
    logger.warn(`[${SERVICE_NAME}] No online store publication found. Product may not be visible.`);
  }
}

// FIX: updateProductVariant 함수 수정
async function updateProductVariant(variantInput) {
  // Get the product ID for this variant
  const getProductQuery = `
    query getProductFromVariant($id: ID!) {
      productVariant(id: $id) {
        id
        product {
          id
        }
        inventoryItem {
          id
          tracked
        }
      }
    }`;
  
  const productResponse = await shopifyGraphqlRequest(getProductQuery, { id: variantInput.id });
  const variant = productResponse.data?.productVariant;
  const productId = variant?.product?.id;
  const inventoryItemId = variant?.inventoryItem?.id;
  
  if (!productId) {
    throw new Error('Could not find product ID for variant');
  }
  
  logger.info(`[${SERVICE_NAME}] Updating variant ${variantInput.id} with multiple updates`);
  
  // 1. 재고 추적 활성화
  if (inventoryItemId && !variant.inventoryItem?.tracked) {
    await enableInventoryTracking(inventoryItemId);
    logger.info(`[${SERVICE_NAME}] Enabled inventory tracking`);
  }
  
  // 2. 가격과 SKU 업데이트
  if (variantInput.price || variantInput.sku) {
    await updateVariantPriceAndSku(productId, variantInput.id, variantInput.price, variantInput.sku);
  }
  
  // 3. 재고 정책 업데이트
  if (variantInput.inventoryPolicy) {
    await updateVariantInventoryPolicy(productId, variantInput.id, variantInput.inventoryPolicy);
  }
  
  // 4. 재고를 항상 1로 설정
  if (inventoryItemId) {
    await updateInventoryLevel(inventoryItemId, BUNJANG_WAREHOUSE_GID, 1);
    logger.info(`[${SERVICE_NAME}] Set inventory to 1 at BunJang Warehouse`);
  }
  
  return variant;
}

async function updateProduct(productUpdateInput, collectionGIDToJoin = null, collectionGIDToLeave = null) {
  if (!productUpdateInput.id) {
    throw new ValidationError('Shopify product GID (id) is required for update.', [{ field: 'id', message: 'Product GID is required.'}]);
  }
  
  // 제품 존재 여부 먼저 확인
  const checkQuery = `
    query checkProduct($id: ID!) {
      product(id: $id) {
        id
      }
    }`;
  
  try {
    const checkResponse = await shopifyGraphqlRequest(checkQuery, { id: productUpdateInput.id });
    if (!checkResponse.data?.product) {
      logger.warn(`[${SERVICE_NAME}] Product ${productUpdateInput.id} does not exist. Cannot update.`);
      throw new NotFoundError(`Product ${productUpdateInput.id} not found in Shopify`);
    }
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    logger.error(`[${SERVICE_NAME}] Error checking product existence:`, error);
    // 계속 진행
  }
  
  // Remove media field if present
  const { media, ...finalProductUpdateInput } = productUpdateInput;
  
  if (collectionGIDToJoin) {
    finalProductUpdateInput.collectionsToJoin = [collectionGIDToJoin];
  }
  if (collectionGIDToLeave) {
    finalProductUpdateInput.collectionsToLeave = [collectionGIDToLeave];
  }

  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          title
          handle
          status
          updatedAt
          variants(first: 5) {
            edges {
              node {
                id
                sku
                price
                inventoryItem {
                  id
                  tracked
                }
              }
            }
          }
          collections(first: 5) {
            edges {
              node {
                id
                title
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`;
    
  logger.info(`[${SERVICE_NAME}] Attempting to update Shopify product:`, { 
    id: productUpdateInput.id, 
    title: productUpdateInput.title, 
    collectionGIDToJoin, 
    collectionGIDToLeave
  });
  
  const response = await shopifyGraphqlRequest(mutation, { input: finalProductUpdateInput });
  
  // response 구조 수정
  if (response.data?.productUpdate?.userErrors && response.data.productUpdate.userErrors.length > 0) {
    const errorMessage = response.data.productUpdate.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    throw new ExternalServiceError(SERVICE_NAME, null, `Product update failed: ${errorMessage}`, 'SHOPIFY_PRODUCT_UPDATE_ERROR', { userErrors: response.data.productUpdate.userErrors });
  }
  
  const updatedProduct = response.data?.productUpdate?.product;
  
  if (!updatedProduct) {
    throw new ExternalServiceError(SERVICE_NAME, null, 'Product update returned null product', 'SHOPIFY_PRODUCT_UPDATE_NULL');
  }
  
  logger.info(`[${SERVICE_NAME}] Successfully updated Shopify product:`, { 
    id: updatedProduct.id, 
    title: updatedProduct.title,
    variantCount: updatedProduct.variants?.edges?.length || 0
  });
  
  // Ensure inventory tracking is enabled for all variants and set quantity to 1
  if (updatedProduct.variants?.edges?.length > 0) {
    for (const edge of updatedProduct.variants.edges) {
      const variant = edge.node;
      const inventoryItemId = variant.inventoryItem?.id;
      
      try {
        // 재고 추적 활성화
        if (inventoryItemId && !variant.inventoryItem?.tracked) {
          await enableInventoryTracking(inventoryItemId);
          logger.info(`[${SERVICE_NAME}] Enabled inventory tracking for variant ${variant.id}`);
        }
        
        // 재고를 항상 1로 설정
        if (inventoryItemId) {
          await updateInventoryLevel(inventoryItemId, BUNJANG_WAREHOUSE_GID, 1);
          logger.info(`[${SERVICE_NAME}] Set inventory to 1 for variant ${variant.id} at BunJang Warehouse`);
        }
        
      } catch (error) {
        logger.warn(`[${SERVICE_NAME}] Could not update inventory for variant ${variant.id}: ${error.message}`);
      }
    }
  }
  
  // Ensure product is published to online store after update
  try {
    await ensureProductPublished(updatedProduct.id);
  } catch (publishError) {
    logger.error(`[${SERVICE_NAME}] Failed to ensure product publication: ${publishError.message}`);
  }
  
  return updatedProduct;
}

async function ensureProductPublished(productId) {
  // Get online store publication ID
  const pubQuery = `
    query getProductPublications($id: ID!) {
      product(id: $id) {
        id
        resourcePublicationsV2(first: 10) {
          edges {
            node {
              publication {
                id
                name
              }
              isPublished
            }
          }
        }
      }
    }`;
  
  const pubResponse = await shopifyGraphqlRequest(pubQuery, { id: productId });
  const publications = pubResponse.data?.product?.resourcePublicationsV2?.edges || [];
  const onlineStore = publications.find(pub => 
    pub.node.publication.name.toLowerCase().includes('online store') || 
    pub.node.publication.name.toLowerCase() === 'online store'
  );
  
  if (onlineStore && !onlineStore.node.isPublished) {
    // Publish to online store
    const publishMutation = `
      mutation publishProduct($id: ID!, $input: [ResourcePublicationInput!]!) {
        productResourcePublicationsUpdate(id: $id, input: $input) {
          product {
            id
            publishedAt
          }
          userErrors {
            field
            message
          }
        }
      }`;
    
    const publishResult = await shopifyGraphqlRequest(publishMutation, {
      id: productId,
      input: [{
        publicationId: onlineStore.node.publication.id,
        publishDate: new Date().toISOString()
      }]
    });
    
    if (publishResult.data?.productResourcePublicationsUpdate?.userErrors?.length === 0) {
      logger.info(`[${SERVICE_NAME}] Product re-published to online store after update`);
    }
  }
}

const { forceInventoryToOne } = require('../../forceInventoryToOne');

// 항상 재고를 1로 설정하는 함수 - 완전히 재작성
async function updateInventoryLevel(inventoryItemId, locationId, availableQuantity) {
  // 번개장터는 단일 재고 시스템이므로 항상 1로 설정
  const forcedQuantity = 1;
  
  if (!inventoryItemId) {
    logger.error(`[${SERVICE_NAME}] Invalid inventoryItemId for inventory update`);
    return null;
  }

  logger.info(`[${SERVICE_NAME}] === INVENTORY UPDATE START (FORCED TO 1) ===`);
  logger.info(`[${SERVICE_NAME}] Inventory Item ID: ${inventoryItemId}`);
  logger.info(`[${SERVICE_NAME}] Requested quantity ${availableQuantity} will be IGNORED - forcing to 1`);
  
  try {
    // forceInventoryToOne 함수 사용
    await forceInventoryToOne(inventoryItemId, { shopifyGraphqlRequest }, logger);
    
    logger.info(`[${SERVICE_NAME}] === INVENTORY UPDATE END (SUCCESS) ===`);
    return { success: true, quantity: 1 };
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] ❌ Inventory update failed: ${error.message}`);
    logger.info(`[${SERVICE_NAME}] === INVENTORY UPDATE END (FAILED) ===`);
    
    // 실패해도 한 번 더 시도
    try {
      logger.info(`[${SERVICE_NAME}] 재시도 중...`);
      
      // 간단한 방법으로 다시 시도
      const simpleMutation = `
        mutation simpleSetQuantity($input: InventorySetOnHandQuantitiesInput!) {
          inventorySetOnHandQuantities(input: $input) {
            inventoryAdjustmentGroup {
              id
              changes {
                quantityAfterChange
              }
            }
            userErrors {
              message
            }
          }
        }`;
      
      const response = await shopifyGraphqlRequest(simpleMutation, {
        input: {
          reason: "correction",
          setQuantities: [{
            inventoryItemId: inventoryItemId,
            locationId: BUNJANG_WAREHOUSE_GID,
            quantity: 1
          }]
        }
      });
      
      if (response.data?.inventorySetOnHandQuantities?.userErrors?.length === 0) {
        logger.info(`[${SERVICE_NAME}] ✅ 재시도 성공!`);
        return { success: true, quantity: 1 };
      }
    } catch (retryError) {
      logger.error(`[${SERVICE_NAME}] 재시도도 실패: ${retryError.message}`);
    }
    
    throw error;
  }
}
async function appendMediaToProduct(productId, mediaInputs) {
  if (!productId) {
    throw new ValidationError('Product ID is required to append media.', []);
  }
  if (!mediaInputs || !Array.isArray(mediaInputs) || mediaInputs.length === 0) {
    logger.info(`[${SERVICE_NAME}] No media inputs provided to append for product ${productId}. Skipping.`);
    return { mediaUserErrors: [], media: [] };
  }

  // Process and validate URLs
  const processedMediaInputs = mediaInputs.map(media => {
    let url = media.originalSource;
    
    // Convert to HTTPS
    if (url && url.startsWith('http://')) {
      url = url.replace('http://', 'https://');
    }
    
    // Handle {res} placeholder for Bunjang URLs
    if (url && url.includes('{res}')) {
      // Replace {res} with a standard resolution
      url = url.replace('{res}', '856');
      logger.debug(`[${SERVICE_NAME}] Replaced {res} placeholder with 856 in URL: ${url}`);
    }
    
    // Log warning for Bunjang URLs
    if (url && (url.includes('media.bunjang.co.kr') || url.includes('img.bunjang.co.kr'))) {
      logger.warn(`[${SERVICE_NAME}] Bunjang image URL detected: ${url}. These URLs often fail Shopify validation due to regional restrictions.`);
    }
    
    return {
      ...media,
      originalSource: url,
      mediaContentType: media.mediaContentType || 'IMAGE'
    };
  });

  const mutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          id
          status
          alt
          mediaContentType
          preview {
            image {
              url
              width
              height
            }
          }
        }
        mediaUserErrors {
          field
          message
          code
        }
        product {
          id
        }
      }
    }
  `;
  
  logger.info(`[${SERVICE_NAME}] Attempting to append ${processedMediaInputs.length} media items to product ${productId}`);
  
  try {
    const response = await shopifyGraphqlRequest(mutation, { productId, media: processedMediaInputs });
    
    if (response.data?.productCreateMedia?.mediaUserErrors && response.data.productCreateMedia.mediaUserErrors.length > 0) {
      logger.error(`[${SERVICE_NAME}] User errors while appending media to product ${productId}:`, response.data.productCreateMedia.mediaUserErrors);
      
      const failedCount = response.data.productCreateMedia.mediaUserErrors.length;
      const successCount = processedMediaInputs.length - failedCount;
      
      logger.warn(`[${SERVICE_NAME}] ${failedCount} images failed validation (likely due to server access restrictions), ${successCount} may have succeeded.`);
      
      return {
        mediaUserErrors: response.data.productCreateMedia.mediaUserErrors,
        media: response.data.productCreateMedia.media || [],
        warning: `${failedCount} images failed validation. This is common with Bunjang image URLs due to regional server restrictions.`
      };
    }
    
    logger.info(`[${SERVICE_NAME}] Successfully processed media attachment for product ${productId}. Media items processed: ${response.data?.productCreateMedia?.media?.length || 0}`);
    return response.data?.productCreateMedia;
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Exception while appending media to product ${productId}:`, error);
    if (error instanceof ExternalServiceError) throw error;
    throw new ExternalServiceError(SERVICE_NAME, error, `Failed to append media to product ${productId}`);
  }
}

async function findProductByBunjangPidTag(bunjangPid) {
  const searchQuery = `tag:'bunjang_pid:${String(bunjangPid).trim()}'`;
  const query = `
    query productsByTag($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            title
            handle
            metafield(namespace: "bunjang", key: "pid") { id value }
          }
        }
      }
    }`;
    
  logger.info(`[${SERVICE_NAME}] Searching Shopify product by Bunjang PID tag: ${searchQuery}`);
  
  try {
    const response = await shopifyGraphqlRequest(query, { query: searchQuery });
    
    if (response.data?.products?.edges?.length > 0) {
      const productNode = response.data.products.edges[0].node;
      logger.info(`[${SERVICE_NAME}] Found Shopify product by Bunjang PID ${bunjangPid} (tag match): ${productNode.id}`);
      return productNode;
    }
    
    logger.info(`[${SERVICE_NAME}] No Shopify product found matching Bunjang PID tag: ${bunjangPid}.`);
    return null;
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Error searching product by Bunjang PID tag ${bunjangPid}: ${error.message}`);
    throw error;
  }
}

async function updateOrder(orderUpdateInput) {
  if (!orderUpdateInput.id) {
    throw new ValidationError('Shopify Order GID (id) is required for update.', [{ field: 'id', message: 'Order GID is required.'}]);
  }
  
  const mutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order {
          id
          updatedAt
          tags
          metafields(first: 10) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`;
    
  logger.info(`[${SERVICE_NAME}] Attempting to update Shopify order:`, { id: orderUpdateInput.id, keys: Object.keys(orderUpdateInput).filter(k => k !== 'id') });
  const response = await shopifyGraphqlRequest(mutation, { input: orderUpdateInput });
  
  if (response.data?.orderUpdate?.userErrors && response.data.orderUpdate.userErrors.length > 0) {
    const errorMessage = response.data.orderUpdate.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    throw new ExternalServiceError(SERVICE_NAME, null, `Order update failed: ${errorMessage}`, 'SHOPIFY_ORDER_UPDATE_ERROR', { userErrors: response.data.orderUpdate.userErrors });
  }
  
  logger.info(`[${SERVICE_NAME}] Shopify order updated successfully:`, { id: response.data?.orderUpdate?.order?.id });
  return response.data?.orderUpdate?.order;
}

async function addProductsToCollection(collectionGID, productGIDs) {
  if (!collectionGID || !productGIDs || !Array.isArray(productGIDs) || productGIDs.length === 0) {
    throw new ValidationError('Valid Collection GID and at least one Product GID array are required.', []);
  }
  
  const mutation = `
    mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection {
          id
          title
          productsCount
        }
        userErrors {
          field
          message
        }
      }
    }`;
    
  logger.info(`[${SERVICE_NAME}] Attempting to add products to collection:`, { collectionGID, productCount: productGIDs.length });
  const response = await shopifyGraphqlRequest(mutation, { id: collectionGID, productIds: productGIDs });
  
  if (response.data?.collectionAddProducts?.userErrors && response.data.collectionAddProducts.userErrors.length > 0) {
    const errorMessage = response.data.collectionAddProducts.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    throw new ExternalServiceError(SERVICE_NAME, null, `Failed to add products to collection: ${errorMessage}`, 'SHOPIFY_COLLECTION_ADD_ERROR', { userErrors: response.data.collectionAddProducts.userErrors });
  }
  
  logger.info(`[${SERVICE_NAME}] Products added to collection successfully:`, { collectionGID, productsAdded: productGIDs.length, currentProductCount: response.data?.collectionAddProducts?.collection?.productsCount });
  return response.data?.collectionAddProducts?.collection;
}

/**
 * 주문의 특정 메타필드를 조회합니다.
 * @param {string} orderId - Shopify 주문 GID
 * @param {string} namespace - 메타필드 네임스페이스
 * @param {string} key - 메타필드 키
 * @returns {Promise<object|null>} 메타필드 객체 또는 null
 */
async function getOrderMetafield(orderId, namespace, key) {
  const query = `
    query getOrderMetafield($id: ID!, $namespace: String!, $key: String!) {
      order(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          id
          value
          type
        }
      }
    }
  `;
  
  try {
    const response = await shopifyGraphqlRequest(query, { id: orderId, namespace, key });
    return response.data?.order?.metafield || null;
  } catch (error) {
    logger.error('[ShopifySvc] Failed to get order metafield:', error);
    return null;
  }
}

async function deleteProduct(productGid) {
  const mutation = `
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }`;
    
  logger.info(`[${SERVICE_NAME}] Attempting to delete Shopify product:`, { id: productGid });
  
  const response = await shopifyGraphqlRequest(mutation, { 
    input: { id: productGid } 
  });
  
  if (response.data?.productDelete?.userErrors && response.data.productDelete.userErrors.length > 0) {
    const errorMessage = response.data.productDelete.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    throw new ExternalServiceError(SERVICE_NAME, null, `Product deletion failed: ${errorMessage}`, 'SHOPIFY_PRODUCT_DELETE_ERROR', { userErrors: response.data.productDelete.userErrors });
  }
  
  const deletedProductId = response.data?.productDelete?.deletedProductId;
  
  if (!deletedProductId) {
    throw new ExternalServiceError(SERVICE_NAME, null, 'Product deletion returned null', 'SHOPIFY_PRODUCT_DELETE_NULL');
  }
  
  logger.info(`[${SERVICE_NAME}] Successfully deleted Shopify product:`, { id: deletedProductId });
  
  return deletedProductId;
}

async function publishProductToOnlineStore(productId) {
  try {
    // This function is now handled by publishProductToSalesChannels
    return await publishProductToSalesChannels(productId);
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Error in publishProductToOnlineStore:`, error);
    throw error;
  }
}

module.exports = {
  shopifyGraphqlRequest,
  createProduct,
  updateProduct,
  updateProductVariant,
  appendMediaToProduct,
  findProductByBunjangPidTag,
  updateOrder,
  addProductsToCollection,
  updateInventoryLevel,
  publishProductToOnlineStore,
  getOrderMetafield,
  deleteProduct,
  activateInventoryAtLocation,
  getDefaultLocationId,
  updateVariantWithInventoryTracking,
  updateVariantPriceAndSku,
  updateVariantSku,
  enableInventoryTracking,
};