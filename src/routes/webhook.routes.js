// src/routes/webhook.routes.js
// Shopify 웹훅을 처리하는 라우터

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const logger = require('../config/logger');
const orderService = require('../services/orderService');
const inventoryService = require('../services/inventoryService');
const SyncedProduct = require('../models/syncedProduct.model');

// Shopify 웹훅 검증 미들웨어
const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.rawBody;
  
  if (!hmac || !body) {
    logger.error('[Webhook] Missing HMAC or body');
    return res.status(401).send('Unauthorized');
  }
  
  const hash = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(body, 'utf8')
    .digest('base64');
  
  if (hash !== hmac) {
    logger.error('[Webhook] HMAC verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  next();
};

// 주문 생성 웹훅 - 수정된 버전
router.post('/orders/create', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order created: #${order.order_number || order.name} (${order.id})`);
    
    // 1. 번개장터 주문 생성 처리 (재고 처리보다 먼저 실행)
    try {
      logger.info(`[Webhook] Attempting to create Bunjang order for Shopify order ${order.id}`);
      
      const bunjangOrderResult = await orderService.processShopifyOrderForBunjang(
        order, 
        `WEBHOOK-${order.id}`
      );
      
      if (bunjangOrderResult.success) {
        logger.info(`[Webhook] Successfully created Bunjang order(s):`, {
          shopifyOrderId: order.id,
          bunjangOrderIds: bunjangOrderResult.bunjangOrderIds,
          message: bunjangOrderResult.message
        });
      } else {
        logger.error(`[Webhook] Failed to create Bunjang order:`, {
          shopifyOrderId: order.id,
          message: bunjangOrderResult.message
        });
      }
    } catch (orderError) {
      logger.error(`[Webhook] Error creating Bunjang order:`, {
        shopifyOrderId: order.id,
        error: orderError.message,
        stack: orderError.stack
      });
      // 번개장터 주문 생성 실패해도 웹훅은 성공 응답 (재시도 방지)
    }
    
    // 2. 주문 상품별 재고 처리 및 재고 0인 상품 삭제
    for (const lineItem of order.line_items || []) {
      try {
        const variantId = lineItem.variant_id;
        const productId = lineItem.product_id;
        
        logger.debug(`[Webhook] Processing line item:`, {
          productId,
          variantId,
          quantity: lineItem.quantity,
          title: lineItem.title
        });
        
        // DB에서 연결된 번개장터 상품 찾기
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        }).lean();
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          logger.info(`[Webhook] Found Bunjang product:`, {
            bunjangPid: syncedProduct.bunjangPid,
            productName: syncedProduct.bunjangProductName,
            quantity: lineItem.quantity
          });
          
          // 번개장터 재고 확인 및 차감
          const currentStock = await inventoryService.checkAndSyncBunjangInventory(syncedProduct.bunjangPid);
          
          if (currentStock !== null && currentStock >= 0) {
            const newStock = Math.max(0, currentStock - lineItem.quantity);
            
            // 재고가 0이 되면 상품 삭제
            if (newStock === 0) {
              logger.info(`[Webhook] Product out of stock, deleting product PID ${syncedProduct.bunjangPid}`);
              try {
                await inventoryService.deleteProductIfOutOfStock(
                  syncedProduct.bunjangPid, 
                  syncedProduct.shopifyGid
                );
                logger.info(`[Webhook] Successfully deleted out-of-stock product PID ${syncedProduct.bunjangPid}`);
              } catch (deleteError) {
                logger.error(`[Webhook] Failed to delete product PID ${syncedProduct.bunjangPid}:`, deleteError);
              }
            } else {
              // 재고가 남아있으면 업데이트만
              await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, newStock);
              logger.info(`[Webhook] Inventory updated for PID ${syncedProduct.bunjangPid}: ${currentStock} -> ${newStock}`);
            }
          }
        } else {
          logger.warn(`[Webhook] No Bunjang product found for Shopify product ${productId}`);
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to process line item ${lineItem.id}:`, itemError);
        // 개별 아이템 실패는 전체 웹훅 처리를 실패시키지 않음
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order creation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 업데이트 웹훅
router.post('/orders/updated', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order updated: #${order.order_number || order.name} (${order.id}), Status: ${order.financial_status}`);
    
    // 주문 취소시 재고 복구
    if (order.cancelled_at) {
      logger.info(`[Webhook] Order cancelled, restoring inventory`);
      
      for (const lineItem of order.line_items || []) {
        try {
          const productId = lineItem.product_id;
          
          const syncedProduct = await SyncedProduct.findOne({
            $or: [
              { shopifyGid: `gid://shopify/Product/${productId}` },
              { 'shopifyData.id': productId },
              { 'shopifyData.id': String(productId) }
            ]
          }).lean();
          
          if (syncedProduct && syncedProduct.bunjangPid) {
            // 재고 복구
            const currentStock = await inventoryService.checkAndSyncBunjangInventory(syncedProduct.bunjangPid);
            const restoredStock = currentStock + lineItem.quantity;
            await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, restoredStock);
            
            logger.info(`[Webhook] Inventory restored for PID ${syncedProduct.bunjangPid}: ${currentStock} -> ${restoredStock}`);
          }
        } catch (itemError) {
          logger.error(`[Webhook] Failed to restore inventory for item ${lineItem.id}:`, itemError);
        }
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 취소 웹훅
router.post('/orders/cancelled', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order cancelled: #${order.order_number || order.name} (${order.id})`);
    
    // 재고 복구 로직
    for (const lineItem of order.line_items || []) {
      try {
        const productId = lineItem.product_id;
        
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        }).lean();
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          // 재고 복구
          const currentStock = await inventoryService.checkAndSyncBunjangInventory(syncedProduct.bunjangPid);
          const restoredStock = currentStock + lineItem.quantity;
          await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, restoredStock);
          
          logger.info(`[Webhook] Inventory restored for PID ${syncedProduct.bunjangPid}: ${currentStock} -> ${restoredStock}`);
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to restore inventory for item ${lineItem.id}:`, itemError);
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order cancellation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 생성 웹훅
router.post('/products/create', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product created: ${product.title} (${product.id})`);
    
    // 필요한 경우 추가 처리 로직
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product creation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 업데이트 웹훅
router.post('/products/update', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product updated: ${product.title} (${product.id})`);
    
    // 필요한 경우 추가 처리 로직
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 삭제 웹훅
router.post('/products/delete', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product deleted: ${product.id}`);
    
    // DB에서 동기화 정보 삭제
    const productGid = `gid://shopify/Product/${product.id}`;
    await SyncedProduct.deleteOne({ shopifyGid: productGid });
    
    logger.info(`[Webhook] Removed sync record for deleted product ${product.id}`);
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product deletion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;