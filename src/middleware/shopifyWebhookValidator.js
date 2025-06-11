// src/middleware/shopifyWebhookValidator.js
// Shopify 웹훅 요청의 HMAC-SHA256 서명을 검증합니다.

const crypto = require('crypto');
const config = require('../config');
const logger = require('../config/logger');
const { UnauthorizedError, ApiError, AppError } = require('../utils/customErrors');

/**
 * Shopify 웹훅 요청의 HMAC 서명을 검증하는 Express 미들웨어입니다.
 * 이 미들웨어는 반드시 raw request body에 접근할 수 있어야 합니다.
 */
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');

  if (!hmacHeader) {
    logger.warn('[WebhookValidator] HMAC signature is missing.', { shopDomain, topic, path: req.originalUrl });
    return res.status(401).json({ error: 'Unauthorized - Missing HMAC header' });
  }

  // rawBody가 있는지 확인 (Buffer 또는 string)
  let rawBody;
  if (req.rawBody) {
    rawBody = req.rawBody;
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body;
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (req.body && typeof req.body === 'object') {
    // JSON이 이미 파싱된 경우 - 이는 잘못된 설정
    logger.error('[WebhookValidator] Request body is already parsed as JSON. Raw body needed for HMAC verification.');
    return res.status(401).json({ error: 'Unauthorized - Missing body' });
  } else {
    logger.warn('[WebhookValidator] Raw body is missing or empty for HMAC verification.', { shopDomain, topic });
    return res.status(401).json({ error: 'Unauthorized - Missing body' });
  }

  try {
    // rawBody가 string인 경우 Buffer로 변환
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    
    const generatedHash = crypto
      .createHmac('sha256', config.shopify.webhookSecret)
      .update(bodyBuffer, 'utf8')
      .digest('base64');

    // crypto.timingSafeEqual을 사용하여 타이밍 공격 방지
    const hmacBuffer = Buffer.from(hmacHeader, 'base64');
    const generatedHashBuffer = Buffer.from(generatedHash, 'base64');
    
    if (hmacBuffer.length === generatedHashBuffer.length && crypto.timingSafeEqual(hmacBuffer, generatedHashBuffer)) {
      logger.info('[WebhookValidator] Shopify webhook HMAC verification successful.', { shopDomain, topic });
      
      // rawBody를 파싱하여 req.body에 설정 (아직 파싱되지 않은 경우)
      if (!req.body || typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        try {
          req.body = JSON.parse(bodyBuffer.toString('utf8'));
        } catch (parseError) {
          logger.error('[WebhookValidator] Failed to parse webhook body as JSON:', parseError);
          return res.status(400).json({ error: 'Invalid JSON in request body' });
        }
      }
      
      next();
    } else {
      logger.warn('[WebhookValidator] Shopify webhook HMAC verification failed. Signatures do not match.', {
        shopDomain, 
        topic, 
        receivedHmac: hmacHeader.substring(0,10) + '...', 
        calculatedHmac: generatedHash.substring(0,10) + '...',
      });
      return res.status(401).json({ error: 'Unauthorized - Invalid HMAC signature' });
    }
  } catch (error) {
    logger.error('[WebhookValidator] Error during Shopify webhook HMAC verification:', { 
        message: error.message, shopDomain, topic, stack: error.stack 
    });
    if (error instanceof AppError) throw error;
    throw new AppError('HMAC 서명 검증 중 서버 오류가 발생했습니다.', 500, 'HMAC_VERIFICATION_ERROR');
  }
}

module.exports = verifyShopifyWebhook;