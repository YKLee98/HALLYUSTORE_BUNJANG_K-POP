// src/services/catalogService.js

const fs = require('fs-extra');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const csv = require('csv-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const logger = require('../config/logger');
const shopifyService = require('./shopifyService');
const SyncedProduct = require('../models/syncedProduct.model');
const { calculateShopifyPriceUsd } = require('./priceCalculationService');
const { AppError, ExternalServiceError } = require('../utils/customErrors');

const BUNJANG_COLLECTION_GID = 'gid://shopify/Collection/445888299257';
const TEMP_DOWNLOAD_DIR = config.tempDir || './tmp_downloads';

async function generateBunjangAuthHeader() {
  if (!config.bunjang.accessKey || !config.bunjang.secretKey) {
    logger.error('[CatalogSvc] Bunjang API Access Key or Secret Key is missing in configuration.');
    throw new AppError('Bunjang API credentials missing.', 500, 'BUNJANG_CREDENTIALS_MISSING');
  }
  try {
    const secretKeyDecoded = Buffer.from(config.bunjang.secretKey, 'base64');
    const payload = {
      accessKey: config.bunjang.accessKey,
      nonce: uuidv4(),
      iat: Math.floor(Date.now() / 1000),
    };
    const jwtToken = jwt.sign(payload, secretKeyDecoded, { algorithm: 'HS256' });
    return { 'Authorization': `Bearer ${jwtToken}` };
  } catch (error) {
    logger.error('[CatalogSvc] Failed to generate Bunjang JWT:', error);
    throw new AppError('Failed to generate Bunjang JWT.', 500, 'BUNJANG_JWT_ERROR', error);
  }
}

async function downloadAndProcessFile(fileUrl, downloadDir, baseOutputFileName, timeoutMs) {
  await fs.ensureDir(downloadDir);
  const tempDownloadedFilePath = path.join(downloadDir, `${baseOutputFileName}_${Date.now()}.tmp`);
  const finalCsvFilePath = path.join(downloadDir, `${baseOutputFileName}.csv`);

  logger.info(`[CatalogSvc] Attempting download of ${fileUrl}`);
  try {
    const authHeader = await generateBunjangAuthHeader();
    const response = await axios({
      method: 'get',
      url: fileUrl,
      headers: { ...authHeader },
      responseType: 'stream',
      timeout: timeoutMs || config.bunjang?.catalogDownloadTimeoutMs || 180000,
    });

    logger.info(`[CatalogSvc] Download request to ${fileUrl} - Status: ${response.status}`);
    const writer = fs.createWriteStream(tempDownloadedFilePath);
    await pipeline(response.data, writer);
    const stats = await fs.stat(tempDownloadedFilePath);
    logger.info(`[CatalogSvc] File successfully downloaded (raw): ${tempDownloadedFilePath}, Size: ${stats.size} bytes`);

    if (stats.size === 0) {
      await fs.remove(tempDownloadedFilePath);
      throw new Error(`Downloaded file ${tempDownloadedFilePath} is empty.`);
    }

    const contentEncoding = String(response.headers['content-encoding'] || '').toLowerCase();
    logger.info(`[CatalogSvc] Response Content-Encoding: '${contentEncoding}'`);

    if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
      logger.info(`[CatalogSvc] Content-Encoding is gzip. Unzipping ${tempDownloadedFilePath} to ${finalCsvFilePath}...`);
      const gunzip = zlib.createGunzip();
      const source = fs.createReadStream(tempDownloadedFilePath);
      const destination = fs.createWriteStream(finalCsvFilePath);
      await pipeline(source, gunzip, destination);
      logger.info(`[CatalogSvc] File unzipped successfully: ${finalCsvFilePath}`);
      await fs.remove(tempDownloadedFilePath);
    } else {
      logger.info(`[CatalogSvc] Content-Encoding not gzip. Assuming plain CSV. Moving ${tempDownloadedFilePath} to ${finalCsvFilePath}.`);
      await fs.move(tempDownloadedFilePath, finalCsvFilePath, { overwrite: true });
      logger.info(`[CatalogSvc] Plain CSV file moved to: ${finalCsvFilePath}`);
    }
    return finalCsvFilePath;
  } catch (error) {
    const responseStatus = error.response?.status;
    const errorMessage = error.response ? `Status: ${responseStatus}` : error.message;
    logger.error(`[CatalogSvc] Error during download/processing of ${fileUrl}: ${errorMessage}`, { stack: error.stack, responseStatus });
    await fs.remove(tempDownloadedFilePath).catch(err => logger.warn(`[CatalogSvc] Failed to remove temp download file on error: ${tempDownloadedFilePath}`, err));
    await fs.remove(finalCsvFilePath).catch(err => logger.warn(`[CatalogSvc] Failed to remove temp .csv file during error: ${finalCsvFilePath}`, err));
    throw new ExternalServiceError('BunjangCatalogProcessing', error, `번개장터 카탈로그 파일 처리 실패: ${fileUrl}. 원인: ${errorMessage}`);
  }
}

async function parseCsvFileWithRowProcessor(csvFilePath, rowProcessor) {
  const products = [];
  let rowNumber = 0;
  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        rowNumber++;
        const processedRow = rowProcessor(row, rowNumber);
        if (processedRow) {
          products.push(processedRow);
        }
      })
      .on('end', () => {
        logger.info(`[CatalogSvc] Successfully parsed and processed ${products.length} products (from ${rowNumber} CSV data rows) from ${csvFilePath}`);
        resolve({ products, totalRows: rowNumber });
      })
      .on('error', (error) => {
        logger.error(`[CatalogSvc] Error parsing CSV file ${csvFilePath}:`, error);
        reject(new AppError(`CSV 파일 파싱 오류: ${csvFilePath}`, 500, 'CSV_PARSE_ERROR', error));
      });
  });
}

function generateBunjangCatalogFilename(type, date = new Date()) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  if (type === 'full') {
    return `full-${year}${month}${day}.csv.gz`;
  } else if (type === 'segment') {
    const hour = date.getHours().toString().padStart(2, '0');
    return `segment-${year}${month}${day}_${hour}.csv.gz`;
  }
  throw new AppError('유효하지 않은 카탈로그 타입입니다.', 400, 'INVALID_CATALOG_TYPE');
}

function processCatalogRow(row, rowNumber) {
  // 가격 파싱을 더 강력하게 처리
  const parsePrice = (priceStr) => {
    if (!priceStr) return NaN;
    // 문자열인 경우 처리
    if (typeof priceStr === 'string') {
      // 숫자가 아닌 문자 제거 (콤마, 원화 기호 등)
      const cleanedPrice = priceStr.replace(/[^\d.-]/g, '');
      return parseFloat(cleanedPrice);
    }
    return parseFloat(priceStr);
  };

  const product = {
    pid: (row.pid || '').trim(),
    name: (row.name || '').trim(),
    description: (row.description || '').trim(),
    quantity: 1,  // 항상 1로 설정
    price: parsePrice(row.price),
    shippingFee: parsePrice(row.shippingFee || row.shipppingFee || 0),
    condition: (row.condition || 'USED').trim().toUpperCase(),
    saleStatus: (row.saleStatus || '').trim().toUpperCase(),
    keywords: row.keywords ? String(row.keywords).split(',').map(k => k.trim()).filter(Boolean) : [],
    images: row.images,
    categoryId: (row.categoryId || '').trim(),
    categoryName: (row.category_name || row.categoryName || '').trim(),
    brandId: (row.brandId || '').trim(),
    optionsRaw: row.options,
    uid: (row.uid || '').trim(),
    updatedAtString: row.updatedAt,
    createdAtString: row.createdAt,
  };

  // 가격 로깅 추가
  logger.info(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} - Raw price: "${row.price}", Parsed price: ${product.price} KRW, Quantity: 1 (always)`);
  
  if (!isNaN(product.price) && product.price > 0) {
    logger.debug(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} - Valid price: ${product.price} KRW`);
  } else {
    logger.warn(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} - Invalid price: raw="${row.price}", parsed=${product.price}`);
  }

  try {
    if (product.updatedAtString) product.updatedAt = new Date(product.updatedAtString);
    if (product.createdAtString) product.createdAt = new Date(product.createdAtString);
    if ((product.updatedAtString && isNaN(product.updatedAt.getTime())) ||
        (product.createdAtString && isNaN(product.createdAt.getTime()))) {
      throw new Error('Invalid date format in CSV row');
    }
  } catch (e) {
    logger.warn(`[CatalogSvc] Invalid date for PID ${product.pid} (row #${rowNumber}). Dates set to null. updatedAt: "${product.updatedAtString}", createdAt: "${product.createdAtString}"`);
    product.updatedAt = null; product.createdAt = null;
  }

  if (product.saleStatus !== 'SELLING') {
    logger.debug(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} skipped: saleStatus is '${product.saleStatus}' (not SELLING).`);
    return null;
  }
  if (!product.pid || !product.name || isNaN(product.price) || product.price <= 0 || !product.updatedAt) {
    logger.warn(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} skipped due to missing essential data (pid, name, valid price > 0, or valid updatedAt).`);
    return null;
  }
  const filterCategoryIds = config.bunjang.filterCategoryIds || [];
  if (filterCategoryIds.length > 0 && product.categoryId && !filterCategoryIds.includes(product.categoryId)) {
    logger.debug(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} skipped: categoryId '${product.categoryId}' not in filter list [${filterCategoryIds.join(', ')}].`);
    return null;
  }
  if (product.price < 0) {
    logger.warn(`[CatalogSvc] Row #${rowNumber} PID ${product.pid} skipped due to invalid price (${product.price}).`);
    return null;
  }
  return product;
}

function transformBunjangRowToShopifyInput(bunjangProduct, shopifyPriceUsd) {
  logger.info(`[CatalogSvc] Transforming Bunjang product ${bunjangProduct.pid} with price: ${bunjangProduct.price} KRW -> ${shopifyPriceUsd} USD, Quantity: 1 (always)`);
  
  const tags = [`bunjang_import`, `bunjang_pid:${bunjangProduct.pid}`];
  const titleLower = (bunjangProduct.name || '').toLowerCase();
  const descriptionLower = (bunjangProduct.description || '').toLowerCase();
  const categoryLower = (bunjangProduct.categoryName || '').toLowerCase();

  const kpopKeywords = config.bunjang.kpopKeywords || [];
  const kidultKeywords = config.bunjang.kidultKeywords || [];

  if (kpopKeywords.length > 0 && kpopKeywords.some(keyword => titleLower.includes(keyword) || descriptionLower.includes(keyword) || categoryLower.includes(keyword))) {
    tags.push('K-Pop');
  }
  if (kidultKeywords.length > 0 && kidultKeywords.some(keyword => titleLower.includes(keyword) || descriptionLower.includes(keyword) || categoryLower.includes(keyword))) {
    tags.push('Kidult');
  }

  // 항상 ACTIVE 상태로 설정하여 바로 게시되도록 함
  let shopifyStatus = 'ACTIVE';
  
  // *** 중요: 번개장터 상품은 항상 재고를 1로 설정 ***
  const variantQuantity = 1;
  
  // Variant data - 재고 추적 활성화, 가격은 문자열로 확실히 전달
  const variantData = {
    price: String(shopifyPriceUsd), // 문자열로 확실히 변환
    sku: `BJ-${bunjangProduct.pid}`,
    inventoryPolicy: 'DENY',  // 재고가 0이 되면 판매 중지
    inventoryManagement: 'SHOPIFY'  // 재고 추적 활성화
  };

  // BunJang Warehouse 위치 ID 사용 - 확실히 GID 형식으로
  const inventoryInfo = {
    quantity: 1,  // *** 항상 재고를 1로 설정 ***
    locationId: 'gid://shopify/Location/82604261625'  // BunJang Warehouse GID
  };
  
  logger.debug(`[CatalogSvc] Variant data for PID ${bunjangProduct.pid}:`, { 
    price: variantData.price,
    priceType: typeof variantData.price,
    sku: variantData.sku,
    inventoryManagement: variantData.inventoryManagement,
    inventoryQuantity: inventoryInfo.quantity,  // 재고 수량 로깅
    locationId: inventoryInfo.locationId,
    enableInventoryTracking: true  
  });

  if (bunjangProduct.optionsRaw) {
    try {
      let parsedOptions = [];
      if (typeof bunjangProduct.optionsRaw === 'string' && bunjangProduct.optionsRaw.trim()) {
        parsedOptions = JSON.parse(bunjangProduct.optionsRaw.trim());
      } else if (Array.isArray(bunjangProduct.optionsRaw)) {
        parsedOptions = bunjangProduct.optionsRaw;
      }
      if (Array.isArray(parsedOptions) && parsedOptions.length > 0 && parsedOptions[0].id && parsedOptions[0].value) {
        logger.info(`[CatalogSvc] Product PID ${bunjangProduct.pid} has Bunjang options: ${JSON.stringify(parsedOptions)}. Advanced variant/option mapping may be needed.`);
      }
    } catch (e) {
      logger.warn(`[CatalogSvc] Failed to parse Bunjang options for PID ${bunjangProduct.pid}: "${bunjangProduct.optionsRaw}"`, e);
    }
  }
  
  const productInput = {
    title: bunjangProduct.name,
    descriptionHtml: bunjangProduct.description || `Imported from Bunjang. Product ID: ${bunjangProduct.pid}`,
    vendor: config.bunjang.defaultVendor || "BunjangImport",
    productType: bunjangProduct.categoryName || config.bunjang.defaultShopifyProductType || "Uncategorized",
    tags: [...new Set(tags)],
    status: shopifyStatus,
    // Add publishedAt to ensure product is published
    publishedAt: new Date().toISOString()
  };
  
  logger.info(`[CatalogSvc] ProductInput for PID ${bunjangProduct.pid}:`, { 
    title: productInput.title, 
    sku: variantData.sku,
    status: productInput.status,
    locationId: inventoryInfo.locationId,
    price: variantData.price,
    quantity: inventoryInfo.quantity,  // 재고 수량 확인
    inventoryManagement: variantData.inventoryManagement
  });

  return { productInput, variantData, inventoryInfo };
}

// FIX: 가격 업데이트 검증 함수 추가
async function verifyVariantPrice(variantId, expectedPrice) {
  const query = `
    query checkVariantPrice($id: ID!) {
      productVariant(id: $id) {
        id
        price
      }
    }`;
  
  try {
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: variantId });
    const actualPrice = response.data?.productVariant?.price;
    const expected = parseFloat(expectedPrice);
    const actual = parseFloat(actualPrice || '0');
    
    logger.info(`[CatalogSvc] Price verification - Expected: ${expected}, Actual: ${actual}`);
    
    return Math.abs(expected - actual) < 0.01; // 0.01 차이 허용
  } catch (error) {
    logger.error(`[CatalogSvc] Failed to verify variant price: ${error.message}`);
    return false;
  }
}

async function syncBunjangProductToShopify(bunjangProduct, jobId = 'N/A') {
  const bunjangPid = bunjangProduct.pid;
  const bunjangName = bunjangProduct.name;
  const bunjangCatalogUpdatedAt = bunjangProduct.updatedAt;

  logger.info(`[CatalogSvc:Job-${jobId}] Syncing Bunjang PID: ${bunjangPid}, Name: ${bunjangName}, Price: ${bunjangProduct.price} KRW, Quantity: 1 (always)`);
  
  // 가격이 유효한지 먼저 체크
  if (!bunjangProduct.price || bunjangProduct.price <= 0) {
    logger.error(`[CatalogSvc:Job-${jobId}] Invalid price for PID ${bunjangPid}: ${bunjangProduct.price}`);
    return { status: 'error', message: 'Invalid price' };
  }
  
  let syncedDoc = await SyncedProduct.findOne({ bunjangPid }).lean();
  const now = new Date();

  await SyncedProduct.updateOne(
    { bunjangPid },
    {
      $set: {
        lastSyncAttemptAt: now,
        bunjangProductName: bunjangName,
        bunjangUpdatedAt: bunjangCatalogUpdatedAt,
        bunjangOriginalPriceKrw: bunjangProduct.price,
        bunjangOriginalShippingFeeKrw: bunjangProduct.shippingFee,
        bunjangQuantity: 1  // 항상 재고를 1로 설정
      },
      $inc: { syncAttemptCount: 1 },
      $setOnInsert: { bunjangPid, createdAt: now, syncStatus: 'PENDING' }
    },
    { upsert: true }
  );
  syncedDoc = await SyncedProduct.findOne({ bunjangPid }).lean();

  if (syncedDoc.syncStatus === 'SYNCED' &&
      bunjangCatalogUpdatedAt && syncedDoc.bunjangUpdatedAt &&
      new Date(syncedDoc.bunjangUpdatedAt).getTime() >= bunjangCatalogUpdatedAt.getTime() &&
      !config.forceResyncAll
      ) {
    logger.info(`[CatalogSvc:Job-${jobId}] Product ${bunjangPid} already SYNCED and no updates from Bunjang catalog (based on bunjangUpdatedAt). Skipping.`);
    
    // 이미 동기화된 상품도 재고를 1로 확인
    if (syncedDoc.shopifyGid) {
      try {
        await shopifyService.updateInventoryLevel(null, 'gid://shopify/Location/82604261625', 1);
      } catch (err) {
        logger.warn(`[CatalogSvc:Job-${jobId}] Failed to ensure inventory is 1 for existing product ${bunjangPid}: ${err.message}`);
      }
    }
    
    return { status: 'skipped_no_change', message: 'Already synced and no update in catalog based on bunjangUpdatedAt.' };
  }

  let shopifyProductGid = syncedDoc.shopifyGid;
  let existingVariant = null;
  
  if (!shopifyProductGid && bunjangPid) {
    try {
      const existingShopifyProduct = await shopifyService.findProductByBunjangPidTag(bunjangPid);
      if (existingShopifyProduct?.id) {
        shopifyProductGid = existingShopifyProduct.id;
        logger.info(`[CatalogSvc:Job-${jobId}] Found existing Shopify product ${shopifyProductGid} for Bunjang PID ${bunjangPid} via tag search.`);
      }
    } catch (tagSearchError) {
      logger.warn(`[CatalogSvc:Job-${jobId}] Error searching for existing product by tag for Bunjang PID ${bunjangPid}: ${tagSearchError.message}`);
      // Continue without existing product
    }
  }

  try {
    // 가격 계산 - 매우 중요!
    logger.info(`[CatalogSvc:Job-${jobId}] Starting price calculation for PID ${bunjangPid}: ${bunjangProduct.price} KRW`);
    
    // 환율 서비스 상태 확인
    const exchangeRateService = require('./exchangeRateService');
    const rateInfo = exchangeRateService.getCachedRateInfo();
    if (rateInfo) {
      logger.info(`[CatalogSvc:Job-${jobId}] Exchange rate cache info:`, {
        rate: rateInfo.rate,
        ageMinutes: rateInfo.ageMinutes,
        isExpired: rateInfo.isExpired
      });
    } else {
      logger.warn(`[CatalogSvc:Job-${jobId}] No cached exchange rate available`);
    }
    
    const shopifyPriceString = await calculateShopifyPriceUsd(bunjangProduct.price);
    logger.info(`[CatalogSvc:Job-${jobId}] Calculated price for PID ${bunjangPid}: ${bunjangProduct.price} KRW -> ${shopifyPriceString} USD`);
    
    // 가격이 제대로 계산되었는지 확인
    const calculatedPrice = parseFloat(shopifyPriceString);
    if (isNaN(calculatedPrice) || calculatedPrice <= 0) {
      logger.error(`[CatalogSvc:Job-${jobId}] Price calculation failed for PID ${bunjangPid}. Calculated: ${shopifyPriceString}`);
      throw new Error(`Invalid calculated price: ${shopifyPriceString}`);
    }
    
    const transformResult = transformBunjangRowToShopifyInput(bunjangProduct, shopifyPriceString);

    if (!transformResult || !transformResult.productInput) {
      logger.info(`[CatalogSvc:Job-${jobId}] Product PID ${bunjangPid} (Name: ${bunjangName}) skipped by transformBunjangRowToShopifyInput.`);
      await SyncedProduct.updateOne({ bunjangPid }, { $set: { syncStatus: 'SKIPPED_FILTER', lastSyncAttemptAt: now, bunjangUpdatedAt: bunjangCatalogUpdatedAt } });
      return { status: 'skipped_filter', message: 'Filtered out by transformation logic.' };
    }
    
    const { productInput: shopifyProductInput, variantData, inventoryInfo } = transformResult;

    let shopifyApiResult;
    let operationType = '';
    let createdOrUpdatedProductId = null;

    if (shopifyProductGid) {
      operationType = 'update';
      
      // 제품이 실제로 존재하는지 먼저 확인
      try {
        const checkQuery = `
          query checkProduct($id: ID!) {
            product(id: $id) {
              id
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    price
                    inventoryManagement
                    inventoryItem {
                      id
                      tracked
                    }
                  }
                }
              }
            }
          }`;
        
        const checkResponse = await shopifyService.shopifyGraphqlRequest(checkQuery, { id: shopifyProductGid });
        
        if (!checkResponse.data?.product) {
          logger.warn(`[CatalogSvc:Job-${jobId}] Product ${shopifyProductGid} no longer exists in Shopify. Will create new product.`);
          shopifyProductGid = null;
          operationType = 'create';
        } else {
          // 제품이 존재하면 variant 정보 저장
          const existingProductData = checkResponse.data.product;
          if (existingProductData.variants?.edges?.length > 0) {
            existingVariant = existingProductData.variants.edges[0].node;
            logger.info(`[CatalogSvc:Job-${jobId}] Found existing variant ${existingVariant.id} with SKU: ${existingVariant.sku}, Current Price: ${existingVariant.price}, Inventory Management: ${existingVariant.inventoryManagement}, Tracked: ${existingVariant.inventoryItem?.tracked}`);
          }
        }
      } catch (checkError) {
        logger.error(`[CatalogSvc:Job-${jobId}] Error checking product existence: ${checkError.message}`);
        // 에러가 발생하면 create로 전환
        shopifyProductGid = null;
        operationType = 'create';
      }
    } else {
      operationType = 'create';
    }

    if (operationType === 'update' && shopifyProductGid) {
      logger.info(`[CatalogSvc:Job-${jobId}] Attempting to update Shopify product GID: ${shopifyProductGid}`);
      
      // Update product - NO variants in ProductInput
      const updateInput = {
        ...shopifyProductInput,
        id: shopifyProductGid
      };
      
      shopifyApiResult = await shopifyService.updateProduct(updateInput, BUNJANG_COLLECTION_GID, null);
      createdOrUpdatedProductId = shopifyApiResult?.id;
      
      // Update variant and inventory separately after product update
      if (existingVariant && existingVariant.id) {
        try {
          // FIX: 가격 업데이트를 더 확실하게 처리
          const currentPrice = parseFloat(existingVariant.price || '0');
          const newPrice = parseFloat(variantData.price);
          const productId = shopifyApiResult.id;
          
          logger.info(`[CatalogSvc:Job-${jobId}] PRICE UPDATE CHECK - Current: $${currentPrice}, New: $${newPrice}, Difference: $${Math.abs(currentPrice - newPrice)}`);
          
          // 1. 재고 추적 활성화
          if (existingVariant.inventoryItem?.id && !existingVariant.inventoryItem?.tracked) {
            await shopifyService.enableInventoryTracking(existingVariant.inventoryItem.id);
            logger.info(`[CatalogSvc:Job-${jobId}] Enabled inventory tracking`);
          }
          
          // 2. 가격과 SKU 업데이트 - productVariantsBulkUpdate 사용
          await shopifyService.updateVariantPriceAndSku(productId, existingVariant.id, newPrice, variantData.sku);
          logger.info(`[CatalogSvc:Job-${jobId}] Updated variant price to $${newPrice} and SKU to ${variantData.sku}`);
          
          // 3. 가격이 실제로 업데이트되었는지 확인
          const priceUpdated = await verifyVariantPrice(existingVariant.id, newPrice);
          if (!priceUpdated) {
            logger.error(`[CatalogSvc:Job-${jobId}] CRITICAL: Price verification failed after update! Expected: $${newPrice}`);
          } else {
            logger.info(`[CatalogSvc:Job-${jobId}] ✅ Price successfully verified at $${newPrice}`);
          }
          
          // 4. 재고 수량 업데이트 (항상 1로 설정) - 더 강력한 방법 사용
          if (existingVariant.inventoryItem?.id) {
            try {
              const locationId = 'gid://shopify/Location/82604261625';  // BunJang Warehouse GID
              const inventoryItemId = existingVariant.inventoryItem.id;
              
              // 강제로 재고를 1로 설정
              await shopifyService.updateInventoryLevel(inventoryItemId, locationId, 1);
              logger.info(`[CatalogSvc:Job-${jobId}] ✅✅ Inventory forced to 1 at BunJang Warehouse`);
              
            } catch (invError) {
              logger.error(`[CatalogSvc:Job-${jobId}] Failed to update inventory for ${shopifyProductGid}: ${invError.message}`);
              // Continue without failing the whole sync
            }
          }
        } catch (variantError) {
          logger.error(`[CatalogSvc:Job-${jobId}] Failed to update variant or inventory: ${variantError.message}`);
          logger.error(`[CatalogSvc:Job-${jobId}] CRITICAL: Price update failed for product ${shopifyProductGid}. Price should be ${variantData.price} but may still be $0`);
          throw variantError;
        }
      } else {
        // existingVariant가 없는 경우 - 첫 번째 variant를 찾아서 업데이트
        logger.warn(`[CatalogSvc:Job-${jobId}] No existing variant found for product ${shopifyProductGid}. Fetching variant info...`);
        
        try {
          const productQuery = `
            query getProductVariants($id: ID!) {
              product(id: $id) {
                id
                variants(first: 1) {
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
            }
          `;
          
          const productResponse = await shopifyService.shopifyGraphqlRequest(productQuery, { id: shopifyProductGid });
          const firstVariant = productResponse.data?.product?.variants?.edges?.[0]?.node;
          
          if (firstVariant) {
            logger.info(`[CatalogSvc:Job-${jobId}] Found variant ${firstVariant.id} for product ${shopifyProductGid}. Current price: ${firstVariant.price}, New price: ${variantData.price}`);
            
            const newPrice = parseFloat(variantData.price);
            const productId = shopifyProductGid;
            
            // 재고 추적 활성화
            if (firstVariant.inventoryItem?.id && !firstVariant.inventoryItem?.tracked) {
              await shopifyService.enableInventoryTracking(firstVariant.inventoryItem.id);
              logger.info(`[CatalogSvc:Job-${jobId}] Enabled inventory tracking`);
            }
            
            // 가격과 SKU 업데이트
            await shopifyService.updateVariantPriceAndSku(productId, firstVariant.id, newPrice, variantData.sku);
            logger.info(`[CatalogSvc:Job-${jobId}] Updated variant price to $${newPrice}`);
            
            // 재고 업데이트 (항상 1로)
            if (firstVariant.inventoryItem?.id) {
              const locationId = 'gid://shopify/Location/82604261625';  // BunJang Warehouse GID
              const inventoryItemId = firstVariant.inventoryItem.id;
              
              // 강제로 재고를 1로 설정
              await shopifyService.updateInventoryLevel(inventoryItemId, locationId, 1);
              logger.info(`[CatalogSvc:Job-${jobId}] ✅✅ Set inventory to 1 at BunJang Warehouse for variant ${firstVariant.id}`);
            }
          } else {
            logger.error(`[CatalogSvc:Job-${jobId}] No variants found for product ${shopifyProductGid}`);
          }
        } catch (variantFetchError) {
          logger.error(`[CatalogSvc:Job-${jobId}] Failed to fetch and update variant for product ${shopifyProductGid}: ${variantFetchError.message}`);
          throw variantFetchError;
        }
      }
    } else {
      operationType = 'create';
      logger.info(`[CatalogSvc:Job-${jobId}] Attempting to create Shopify product for Bunjang PID: ${bunjangPid}`);
      
      // Create input WITHOUT variants
      const createInput = {
        ...shopifyProductInput
        // DO NOT include variants here
      };
      
      // Pass variant data as third parameter to createProduct
      const variantInfo = {
        price: variantData.price, // 이미 문자열
        sku: variantData.sku,
        inventoryPolicy: variantData.inventoryPolicy,
        quantity: 1,  // *** 항상 재고를 1로 설정 ***
        locationId: 'gid://shopify/Location/82604261625',  // BunJang Warehouse GID
        enableInventoryTracking: true  // 재고 추적 활성화
      };
      
      logger.debug(`[CatalogSvc:Job-${jobId}] CreateInput structure (without variants):`, JSON.stringify(createInput, null, 2));
      logger.debug(`[CatalogSvc:Job-${jobId}] Variant info to be applied after creation:`, variantInfo);
      
      // Create product and handle variant separately
      shopifyApiResult = await shopifyService.createProduct(createInput, BUNJANG_COLLECTION_GID, variantInfo);
      createdOrUpdatedProductId = shopifyApiResult?.id;
      
      // FIX: 생성 후 재고 확인 및 강제 설정
      if (createdOrUpdatedProductId && shopifyApiResult.variants?.edges?.length > 0) {
        const createdVariant = shopifyApiResult.variants.edges[0].node;
        const createdPrice = parseFloat(createdVariant.price || '0');
        const expectedPrice = parseFloat(variantInfo.price);
        
        logger.info(`[CatalogSvc:Job-${jobId}] Created product price check - Expected: $${expectedPrice}, Actual: $${createdPrice}`);
        
        if (Math.abs(createdPrice - expectedPrice) > 0.01) {
          logger.error(`[CatalogSvc:Job-${jobId}] CRITICAL: Created product has wrong price! Expected: $${expectedPrice}, Actual: $${createdPrice}`);
          
          try {
            // 다시 한 번 가격 업데이트 시도
            await shopifyService.updateVariantPriceAndSku(createdOrUpdatedProductId, createdVariant.id, expectedPrice, variantInfo.sku);
            logger.info(`[CatalogSvc:Job-${jobId}] Price corrected to $${expectedPrice}`);
          } catch (priceFixError) {
            logger.error(`[CatalogSvc:Job-${jobId}] Failed to fix price: ${priceFixError.message}`);
          }
        }
        
        // 재고를 강제로 1로 설정
        if (createdVariant.inventoryItem?.id) {
          try {
            await shopifyService.updateInventoryLevel(createdVariant.inventoryItem.id, 'gid://shopify/Location/82604261625', 1);
            logger.info(`[CatalogSvc:Job-${jobId}] ✅✅ Forced inventory to 1 for newly created product`);
          } catch (invError) {
            logger.error(`[CatalogSvc:Job-${jobId}] Failed to force inventory to 1: ${invError.message}`);
          }
        }
      }
    }

    if (!createdOrUpdatedProductId) {
      throw new Error('Shopify API did not return a valid product ID after create/update.');
    }

    // FIX: 최종 가격 및 재고 확인
    try {
      const finalCheckQuery = `
        query checkFinalPrice($id: ID!) {
          product(id: $id) {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  inventoryItem {
                    id
                    tracked
                    inventoryLevels(first: 5) {
                      edges {
                        node {
                          location {
                            id
                            name
                          }
                          available
                        }
                      }
                    }
                  }
                  inventoryQuantity
                }
              }
            }
          }
        }`;
      
      const finalCheckResponse = await shopifyService.shopifyGraphqlRequest(finalCheckQuery, { id: createdOrUpdatedProductId });
      const finalVariant = finalCheckResponse.data?.product?.variants?.edges?.[0]?.node;
      
      if (finalVariant) {
        const finalPrice = parseFloat(finalVariant.price || '0');
        const expectedPrice = parseFloat(shopifyPriceString);
        const isTracked = finalVariant.inventoryItem?.tracked;
        const finalQuantity = finalVariant.inventoryQuantity;
        const inventoryLevels = finalVariant.inventoryItem?.inventoryLevels?.edges || [];
        
        logger.info(`[CatalogSvc:Job-${jobId}] FINAL CHECK - Price: Expected $${expectedPrice}, Actual $${finalPrice}, Inventory Tracked: ${isTracked}, Total Quantity: ${finalQuantity}`);
        
        // 재고 위치별 수량 확인
        if (inventoryLevels.length > 0) {
          logger.info(`[CatalogSvc:Job-${jobId}] Inventory levels by location:`);
          for (const edge of inventoryLevels) {
            const location = edge.node.location;
            const available = edge.node.available;
            logger.info(`[CatalogSvc:Job-${jobId}]   - ${location.name} (${location.id}): ${available} units`);
            
            // BunJang Warehouse 확인
            if (location.id.includes('82604261625')) {
              if (available === 1) {
                logger.info(`[CatalogSvc:Job-${jobId}] ✅ BunJang Warehouse inventory correctly set to 1`);
              } else {
                logger.error(`[CatalogSvc:Job-${jobId}] ❌ BunJang Warehouse inventory is ${available} instead of 1`);
                
                // 재고가 1이 아니면 다시 설정 시도
                if (finalVariant.inventoryItem?.id) {
                  try {
                    await shopifyService.updateInventoryLevel(finalVariant.inventoryItem.id, 'gid://shopify/Location/82604261625', 1);
                    logger.info(`[CatalogSvc:Job-${jobId}] ✅ Forced inventory to 1 in final check`);
                  } catch (err) {
                    logger.error(`[CatalogSvc:Job-${jobId}] Failed to force inventory in final check: ${err.message}`);
                  }
                }
              }
            }
          }
        } else {
          logger.warn(`[CatalogSvc:Job-${jobId}] ⚠️ No inventory levels found for the product`);
        }
        
        if (Math.abs(finalPrice - expectedPrice) > 0.01) {
          logger.error(`[CatalogSvc:Job-${jobId}] ❌ FINAL PRICE MISMATCH! Product ${createdOrUpdatedProductId} has price $${finalPrice} instead of expected $${expectedPrice}`);
        } else {
          logger.info(`[CatalogSvc:Job-${jobId}] ✅ Final price verified correctly at $${finalPrice}`);
        }
        
        if (!isTracked) {
          logger.error(`[CatalogSvc:Job-${jobId}] ❌ INVENTORY TRACKING NOT ENABLED! Product ${createdOrUpdatedProductId}`);
        } else {
          logger.info(`[CatalogSvc:Job-${jobId}] ✅ Inventory tracking is enabled`);
        }
      }
    } catch (finalCheckError) {
      logger.error(`[CatalogSvc:Job-${jobId}] Failed to perform final check: ${finalCheckError.message}`);
    }

    // 이미지 첨부 단계
    const bunjangImageUrls = bunjangProduct.images;
    let mediaInputsToAttach = [];
    const productNameForAlt = bunjangProduct.name ? bunjangProduct.name.substring(0, 250) : 'Product image';

    // 이미지 URL 유효성 검사 및 변환 함수
    const processImageUrl = (url) => {
        if (!url || typeof url !== 'string') return null;
        let processedUrl = url.trim();
        
        // Ensure HTTPS for better Shopify compatibility
        if (processedUrl.startsWith('http://')) {
            processedUrl = processedUrl.replace('http://', 'https://');
            logger.debug(`[CatalogSvc:Job-${jobId}] Converted HTTP to HTTPS: ${processedUrl}`);
        }
        
        // Replace {res} placeholder with standard resolution
        if (processedUrl.includes('{res}')) {
            processedUrl = processedUrl.replace('{res}', '856');
            logger.debug(`[CatalogSvc:Job-${jobId}] Replaced {res} placeholder with 856 in URL: ${processedUrl}`);
        }
        
        // Basic URL validation
        if (!processedUrl.startsWith('https://')) return null;
        
        // 번개장터 이미지 서버 도메인 확인
        const bunjangDomains = ['media.bunjang.co.kr', 'img.bunjang.co.kr', 'img2.bunjang.co.kr'];
        try {
            const urlObj = new URL(processedUrl);
            const isBunjangUrl = bunjangDomains.some(domain => urlObj.hostname.includes(domain));
            
            // Accept Bunjang URLs (even though they might fail later) and standard image files
            if (isBunjangUrl) {
                logger.debug(`[CatalogSvc:Job-${jobId}] Bunjang image URL will be attempted: ${processedUrl}`);
                return processedUrl;
            }
            
            // For non-Bunjang URLs, check for image extensions
            if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(urlObj.pathname)) {
                return processedUrl;
            }
            
            // Also accept URLs without extensions if they're from known CDNs
            const knownCdns = ['cloudinary.com', 'imgix.net', 'amazonaws.com', 'googleusercontent.com'];
            if (knownCdns.some(cdn => urlObj.hostname.includes(cdn))) {
                return processedUrl;
            }
            
            return null;
        } catch (e) {
            return null;
        }
    };

    if (typeof bunjangImageUrls === 'string' && bunjangImageUrls.trim() !== '') {
        mediaInputsToAttach = bunjangImageUrls.split(',')
            .map(url => url.trim())
            .map(url => processImageUrl(url))
            .filter(url => {
                if (!url) {
                    logger.debug(`[CatalogSvc:Job-${jobId}] Invalid or unsupported image URL skipped`);
                    return false;
                }
                return true;
            })
            .map(url => ({ 
                originalSource: url, 
                mediaContentType: 'IMAGE', 
                alt: productNameForAlt 
            }));
    } else if (Array.isArray(bunjangImageUrls)) {
        mediaInputsToAttach = bunjangImageUrls
            .map(url => String(url || '').trim())
            .map(url => processImageUrl(url))
            .filter(url => {
                if (!url) {
                    logger.debug(`[CatalogSvc:Job-${jobId}] Invalid or unsupported image URL skipped`);
                    return false;
                }
                return true;
            })
            .map(url => ({ 
                originalSource: url, 
                mediaContentType: 'IMAGE', 
                alt: productNameForAlt 
            }));
    }
    
    if (mediaInputsToAttach.length > 0) {
        if (shopifyService.appendMediaToProduct) {
            try {
                logger.info(`[CatalogSvc:Job-${jobId}] Attaching ${mediaInputsToAttach.length} media items to product ${createdOrUpdatedProductId}`);
                const mediaResult = await shopifyService.appendMediaToProduct(createdOrUpdatedProductId, mediaInputsToAttach.slice(0, 250));
                
                // Log warning if some images failed (common with Bunjang URLs)
                if (mediaResult?.warning) {
                    logger.warn(`[CatalogSvc:Job-${jobId}] Media attachment warning: ${mediaResult.warning}`);
                }
                
                const successfulMedia = mediaResult?.media?.filter(m => m.status !== 'FAILED')?.length || 0;
                if (successfulMedia > 0) {
                    logger.info(`[CatalogSvc:Job-${jobId}] Successfully attached ${successfulMedia} media items to product.`);
                }
            } catch (mediaError) {
                // Don't fail the entire sync if media attachment fails
                logger.error(`[CatalogSvc:Job-${jobId}] Failed to attach media to product ${createdOrUpdatedProductId}: ${mediaError.message}`, { stack: mediaError.stack });
                // Continue with the sync - product is already created/updated
            }
        } else {
            logger.warn(`[CatalogSvc:Job-${jobId}] shopifyService.appendMediaToProduct function is not defined. Skipping media attachment for product ${createdOrUpdatedProductId}.`);
        }
    }

    await SyncedProduct.updateOne({ bunjangPid }, {
      $set: {
        shopifyGid: createdOrUpdatedProductId,
        shopifyProductId: createdOrUpdatedProductId.split('/').pop(),
        shopifyHandle: shopifyApiResult.handle,
        lastSuccessfulSyncAt: now,
        syncStatus: 'SYNCED',
        syncErrorMessage: null,
        syncErrorStackSample: null,
        shopifyListedPriceUsd: shopifyPriceString,
        bunjangUpdatedAt: bunjangCatalogUpdatedAt,
        syncAttemptCount: 0,
        bunjangQuantity: 1,  // DB에도 재고 1로 저장
        lastInventorySyncAt: now  // 재고 동기화 시간 업데이트
      },
      $inc: { syncSuccessCount: 1 },
    });

    logger.info(`[CatalogSvc:Job-${jobId}] Successfully ${operationType}d Shopify product ${createdOrUpdatedProductId} for Bunjang PID ${bunjangPid}. Price: ${shopifyPriceString}, Inventory: 1 at BunJang Warehouse`);
    return { status: 'success', operation: operationType, shopifyGid: createdOrUpdatedProductId };

  } catch (error) {
    let errorMessage = error.message;
    if (error.userErrors && Array.isArray(error.userErrors) && error.userErrors.length > 0) {
        errorMessage = error.userErrors.map(e => `Field: ${e.field?.join(',') || 'N/A'}, Msg: ${e.message}`).join('; ');
    } else if (error.networkError) {
        errorMessage = `Network error: ${error.message}`;
    }
    const errorStackSample = error.stack ? error.stack.substring(0, 1000) : null;
    logger.error(`[CatalogSvc:Job-${jobId}] Failed to ${shopifyProductGid ? 'update' : 'create'} Shopify product for Bunjang PID ${bunjangPid}: ${errorMessage}`, { originalErrorStack: error.originalError?.stack || error.stack });

    await SyncedProduct.updateOne({ bunjangPid }, {
      $set: {
        syncStatus: 'ERROR',
        syncErrorMessage: errorMessage.substring(0, 1000),
        syncErrorStackSample: errorStackSample,
        bunjangUpdatedAt: bunjangCatalogUpdatedAt,
        ...(shopifyProductGid && { shopifyGid: shopifyProductGid })
      }
    });
    return { status: 'error', message: errorMessage.substring(0, 255), shopifyGid: shopifyProductGid };
  }
}

async function fetchAndProcessBunjangCatalog(catalogType, jobIdForLog = 'N/A') {
  logger.info(`[CatalogSvc:Job-${jobIdForLog}] Starting Bunjang catalog processing. Type: ${catalogType}`);
  let catalogFileUrl;
  let catalogFileNameGz;
  let baseFileNameWithoutExt;

  const fileDate = new Date();
  catalogFileNameGz = generateBunjangCatalogFilename(catalogType, fileDate);
  baseFileNameWithoutExt = catalogFileNameGz.replace(/\.csv\.gz$/, '');

  if (!config.bunjang?.catalogApiUrl) {
    logger.error(`[CatalogSvc:Job-${jobIdForLog}] Bunjang catalog API URL (config.bunjang.catalogApiUrl) is not configured.`);
    throw new AppError("Bunjang catalog API URL is not configured.", 500, "BUNJANG_URL_MISSING");
  }
  catalogFileUrl = `${config.bunjang.catalogApiUrl}/catalog/${catalogType}/${catalogFileNameGz}`;
  logger.info(`[CatalogSvc:Job-${jobIdForLog}] Catalog file to process: ${catalogFileNameGz}, URL: ${catalogFileUrl}`);

  if (!TEMP_DOWNLOAD_DIR) {
    logger.error(`[CatalogSvc:Job-${jobIdForLog}] Temporary directory (TEMP_DOWNLOAD_DIR from config.tempDir) is not configured.`);
    throw new AppError("Temporary directory for downloads is not configured.", 500, "TEMP_DIR_MISSING");
  }
  const localCsvPath = await downloadAndProcessFile(catalogFileUrl, TEMP_DOWNLOAD_DIR, baseFileNameWithoutExt);
  logger.info(`[CatalogSvc:Job-${jobIdForLog}] Parsing CSV file: ${localCsvPath}`);
  const { products: bunjangProducts, totalRows: originalCsvRowCount } = await parseCsvFileWithRowProcessor(localCsvPath, processCatalogRow);

  if (!bunjangProducts || bunjangProducts.length === 0) {
    logger.warn(`[CatalogSvc:Job-${jobIdForLog}] No valid products found after filtering in CSV file: ${localCsvPath}. Processing finished.`);
    if (await fs.pathExists(localCsvPath)) await fs.remove(localCsvPath);
    return { filename: catalogFileNameGz, totalOriginalCsvRows: originalCsvRowCount || 0, validProductsToProcess: 0, successfullyProcessed: 0, errors: 0, skippedByFilter: 0, skippedNoChange: 0 };
  }

  let successfullyProcessed = 0;
  let errorCount = 0;
  let skippedByFilterCount = 0;
  let skippedNoChangeCount = 0;

  logger.info(`[CatalogSvc:Job-${jobIdForLog}] Processing ${bunjangProducts.length} valid items from Bunjang catalog...`);
  const concurrency = config.bunjang?.syncConcurrency || 1;
  const productChunks = [];
  for (let i = 0; i < bunjangProducts.length; i += concurrency) {
    productChunks.push(bunjangProducts.slice(i, i + concurrency));
  }

  for (const chunk of productChunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map(product => syncBunjangProductToShopify(product, jobIdForLog))
    );
    chunkResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        if (result.value.status === 'success') successfullyProcessed++;
        else if (result.value.status === 'skipped_filter') skippedByFilterCount++;
        else if (result.value.status === 'skipped_no_change') skippedNoChangeCount++;
        else if (result.value.status === 'error') errorCount++;
      } else if (result.status === 'rejected') {
        errorCount++;
        logger.error(`[CatalogSvc:Job-${jobIdForLog}] Unhandled promise rejection in sync chunk for a product:`, result.reason);
      }
    });
    logger.debug(`[CatalogSvc:Job-${jobIdForLog}] Processed a chunk. Totals - Success: ${successfullyProcessed}, FilterSkip: ${skippedByFilterCount}, NoChangeSkip: ${skippedNoChangeCount}, Errors: ${errorCount} / TotalValid: ${bunjangProducts.length}`);
  }

  if (await fs.pathExists(localCsvPath)) {
    await fs.remove(localCsvPath)
      .then(() => logger.info(`[CatalogSvc:Job-${jobIdForLog}] Cleaned up local CSV file: ${localCsvPath}`))
      .catch(unlinkError => logger.warn(`[CatalogSvc:Job-${jobIdForLog}] Failed to clean up local CSV file ${localCsvPath}:`, unlinkError));
  }

  const summary = {
    filename: catalogFileNameGz,
    totalOriginalCsvRows: originalCsvRowCount || 0,
    validProductsToProcess: bunjangProducts.length,
    successfullyProcessed,
    errors: errorCount,
    skippedByFilter: skippedByFilterCount,
    skippedNoChange: skippedNoChangeCount,
  };
  logger.info(`[CatalogSvc:Job-${jobIdForLog}] Bunjang catalog processing finished. Summary:`, summary);
  return summary;
}

module.exports = {
  fetchAndProcessBunjangCatalog,
};