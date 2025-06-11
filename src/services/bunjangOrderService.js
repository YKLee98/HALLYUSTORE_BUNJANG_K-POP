// src/services/bunjangOrderService.js

const axios = require('axios');
const logger = require('../config/logger');
const { shopifyGraphqlRequest, updateOrder } = require('./shopifyService');
const { ExternalServiceError, ValidationError } = require('../utils/customErrors');

const SERVICE_NAME = 'BunjangOrderSvc';

class BunjangOrderService {
  constructor(config) {
    this.baseURL = 'https://openapi.bunjang.co.kr';
    this.token = config.bunjang.apiToken;
    this.shopifyConfig = config.shopify;
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // 에러 인터셉터
    this.client.interceptors.response.use(
      response => response,
      error => this.handleApiError(error)
    );
  }

  // Shopify 주문을 번개장터로 전송
  async createBunjangOrder(shopifyOrder) {
    try {
      logger.info(`[${SERVICE_NAME}] Processing Shopify order for Bunjang:`, {
        orderId: shopifyOrder.id,
        orderName: shopifyOrder.name
      });

      // 1. 주문 항목에서 번개장터 정보 추출
      const bunjangItems = await this.extractBunjangItems(shopifyOrder);
      
      if (bunjangItems.length === 0) {
        logger.warn(`[${SERVICE_NAME}] No Bunjang items found in order ${shopifyOrder.id}`);
        return null;
      }

      // 2. 각 번개장터 상품에 대해 주문 생성
      const createdOrders = [];
      
      for (const item of bunjangItems) {
        try {
          const bunjangOrder = await this.createOrder({
            product: {
              id: item.bunjangPid,
              price: item.price
            },
            deliveryPrice: item.shippingFee
          });

          createdOrders.push({
            bunjangOrderId: bunjangOrder.id,
            bunjangPid: item.bunjangPid,
            shopifyLineItemId: item.lineItemId
          });

          logger.info(`[${SERVICE_NAME}] Created Bunjang order:`, {
            bunjangOrderId: bunjangOrder.id,
            bunjangPid: item.bunjangPid
          });

        } catch (error) {
          logger.error(`[${SERVICE_NAME}] Failed to create order for product ${item.bunjangPid}:`, error);
          // 부분 실패 시 계속 진행
          continue;
        }
      }

      // 3. Shopify 주문에 번개장터 주문 정보 저장
      if (createdOrders.length > 0) {
        await this.updateShopifyOrderWithBunjangInfo(shopifyOrder.id, createdOrders);
      }

      return createdOrders;

    } catch (error) {
      logger.error(`[${SERVICE_NAME}] Failed to process order:`, error);
      throw error;
    }
  }

  // 번개장터 주문 생성 API 호출
  async createOrder(orderData) {
    try {
      const response = await this.client.post('/api/v2/orders', orderData);
      return response.data.data;
    } catch (error) {
      throw error; // 인터셉터에서 처리
    }
  }

  // 번개장터 주문 조회
  async getOrder(orderId) {
    try {
      const response = await this.client.get(`/api/v1/orders/${orderId}`);
      return response.data.data;
    } catch (error) {
      throw error;
    }
  }

  // 번개장터 주문 목록 조회
  async getOrders(params) {
    try {
      // 필수 파라미터 검증
      if (!params.statusUpdateStartDate || !params.statusUpdateEndDate) {
        throw new ValidationError('Start and end dates are required');
      }

      // 날짜 범위 검증 (최대 15일)
      const startDate = new Date(params.statusUpdateStartDate);
      const endDate = new Date(params.statusUpdateEndDate);
      const diffDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
      
      if (diffDays > 15) {
        throw new ValidationError('Date range cannot exceed 15 days');
      }

      const response = await this.client.get('/api/v1/orders', {
        params: {
          statusUpdateStartDate: params.statusUpdateStartDate,
          statusUpdateEndDate: params.statusUpdateEndDate,
          page: params.page || 0,
          size: Math.min(params.size || 100, 100) // 최대 100
        }
      });

      return response.data;
    } catch (error) {
      throw error;
    }
  }

  // 번개장터 주문 확정
  async confirmOrder(orderId) {
    try {
      await this.client.post(`/api/v1/orders/${orderId}/confirm-purchase`);
      logger.info(`[${SERVICE_NAME}] Order ${orderId} confirmed successfully`);
      return true;
    } catch (error) {
      throw error;
    }
  }

  // 주문 상태 동기화
  async syncOrderStatus(startDate, endDate) {
    try {
      logger.info(`[${SERVICE_NAME}] Starting order status sync from ${startDate} to ${endDate}`);
      
      let page = 0;
      let hasMore = true;
      const updatedOrders = [];

      while (hasMore) {
        const response = await this.getOrders({
          statusUpdateStartDate: startDate,
          statusUpdateEndDate: endDate,
          page: page,
          size: 100
        });

        for (const order of response.data) {
          try {
            await this.updateShopifyOrderStatus(order);
            updatedOrders.push(order.id);
          } catch (error) {
            logger.error(`[${SERVICE_NAME}] Failed to update order ${order.id} status:`, error);
          }
        }

        hasMore = page < response.totalPages - 1;
        page++;
      }

      logger.info(`[${SERVICE_NAME}] Order status sync completed. Updated ${updatedOrders.length} orders`);
      return updatedOrders;

    } catch (error) {
      logger.error(`[${SERVICE_NAME}] Order status sync failed:`, error);
      throw error;
    }
  }

  // Shopify 주문 상태 업데이트
  async updateShopifyOrderStatus(bunjangOrder) {
    const statusMapping = this.mapBunjangStatusToShopify(bunjangOrder.orderItems[0].status);
    
    if (!statusMapping) {
      logger.warn(`[${SERVICE_NAME}] Unknown Bunjang status: ${bunjangOrder.orderItems[0].status}`);
      return;
    }

    // Shopify에서 해당 주문 찾기
    const shopifyOrder = await this.findShopifyOrderByBunjangId(bunjangOrder.id);
    if (!shopifyOrder) {
      logger.warn(`[${SERVICE_NAME}] Shopify order not found for Bunjang order ${bunjangOrder.id}`);
      return;
    }

    // 상태에 따른 처리
    if (statusMapping.action === 'fulfillment') {
      await this.createOrUpdateFulfillment(shopifyOrder.id, statusMapping.status, bunjangOrder);
    } else if (statusMapping.action === 'cancel') {
      await this.cancelShopifyOrder(shopifyOrder.id, statusMapping.reason);
    }

    // 메타필드 업데이트
    await updateOrder({
      id: shopifyOrder.id,
      metafields: [{
        namespace: 'bunjang',
        key: 'last_status',
        value: bunjangOrder.orderItems[0].status,
        type: 'single_line_text_field'
      }, {
        namespace: 'bunjang',
        key: 'status_updated_at',
        value: bunjangOrder.orderItems[0].statusUpdatedAt,
        type: 'single_line_text_field'
      }]
    });
  }

  // 헬퍼 메서드들
  async extractBunjangItems(shopifyOrder) {
    const bunjangItems = [];
    
    for (const lineItem of shopifyOrder.lineItems.edges) {
      const item = lineItem.node;
      
      // 상품의 번개장터 PID 추출
      const bunjangPidTag = item.product.tags.find(tag => tag.startsWith('bunjang_pid:'));
      if (!bunjangPidTag) continue;
      
      const bunjangPid = parseInt(bunjangPidTag.split(':')[1]);
      
      // 메타필드에서 배송비 정보 가져오기
      const shippingFeeMetafield = item.product.metafields.edges.find(
        edge => edge.node.namespace === 'bunjang' && edge.node.key === 'shipping_fee'
      );
      
      const shippingFee = shippingFeeMetafield 
        ? parseInt(shippingFeeMetafield.node.value) 
        : 0;

      bunjangItems.push({
        lineItemId: item.id,
        bunjangPid: bunjangPid,
        price: Math.floor(parseFloat(item.originalTotalSet.shopMoney.amount) * 100),
        shippingFee: shippingFee,
        quantity: item.quantity
      });
    }
    
    return bunjangItems;
  }

  async updateShopifyOrderWithBunjangInfo(shopifyOrderId, bunjangOrders) {
    const metafields = [];
    const tags = [];
    
    // 번개장터 주문 ID들을 JSON으로 저장
    metafields.push({
      namespace: 'bunjang',
      key: 'order_ids',
      value: JSON.stringify(bunjangOrders.map(o => o.bunjangOrderId)),
      type: 'json'
    });
    
    // 각 주문에 대한 태그 추가
    bunjangOrders.forEach(order => {
      tags.push(`bunjang_order:${order.bunjangOrderId}`);
    });
    
    // 주문 생성 시간
    metafields.push({
      namespace: 'bunjang',
      key: 'order_created_at',
      value: new Date().toISOString(),
      type: 'single_line_text_field'
    });
    
    await updateOrder({
      id: shopifyOrderId,
      metafields: metafields,
      tags: tags
    });
  }

  async findShopifyOrderByBunjangId(bunjangOrderId) {
    const query = `
      query findOrderByBunjangId($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    product {
                      id
                      tags
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await shopifyGraphqlRequest(query, {
      query: `tag:bunjang_order\\:${bunjangOrderId}`
    });
    
    if (response.data.orders.edges.length > 0) {
      return response.data.orders.edges[0].node;
    }
    
    return null;
  }

  mapBunjangStatusToShopify(bunjangStatus) {
    const statusMap = {
      'PAYMENT_RECEIVED': { action: 'none', status: 'pending' },
      'SHIP_READY': { action: 'fulfillment', status: 'pending' },
      'IN_TRANSIT': { action: 'fulfillment', status: 'in_transit' },
      'DELIVERY_COMPLETED': { action: 'fulfillment', status: 'delivered' },
      'PURCHASE_CONFIRM': { action: 'fulfillment', status: 'confirmed' },
      'CANCEL_REQUESTED_BEFORE_SHIPPING': { action: 'cancel', reason: 'customer' },
      'REFUNDED': { action: 'refund', status: 'refunded' },
      'RETURN_REQUESTED': { action: 'return', status: 'return_pending' },
      'RETURNED': { action: 'return', status: 'returned' }
    };
    
    return statusMap[bunjangStatus] || null;
  }

  async createOrUpdateFulfillment(orderId, status, bunjangOrder) {
    // 배송 정보가 있는 경우 처리
    if (bunjangOrder.delivery && bunjangOrder.delivery.invoice) {
      const fulfillmentInput = {
        orderId: orderId,
        trackingCompany: this.mapDeliveryCompany(bunjangOrder.delivery.invoice.companyCode),
        trackingNumber: bunjangOrder.delivery.invoice.no,
        trackingUrls: [this.getTrackingUrl(bunjangOrder.delivery.invoice.companyCode, bunjangOrder.delivery.invoice.no)],
        notifyCustomer: true
      };
      
      // Shopify fulfillment 생성/업데이트 로직
      logger.info(`[${SERVICE_NAME}] Creating fulfillment for order ${orderId}`);
    }
  }

  mapDeliveryCompany(companyCode) {
    const companyMap = {
      'cj': 'CJ Logistics',
      'hanjin': 'Hanjin Express',
      'lotte': 'Lotte Global Logistics',
      'post': 'Korea Post',
      'logen': 'Logen'
    };
    
    return companyMap[companyCode] || companyCode;
  }

  getTrackingUrl(companyCode, trackingNumber) {
    const urlMap = {
      'cj': `https://www.cjlogistics.com/ko/tool/parcel/tracking?gnbInvcNo=${trackingNumber}`,
      'hanjin': `https://www.hanjin.co.kr/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=${trackingNumber}`,
      'lotte': `https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=${trackingNumber}`,
      'post': `https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=${trackingNumber}`,
      'logen': `https://www.ilogen.com/web/personal/trace/${trackingNumber}`
    };
    
    return urlMap[companyCode] || '#';
  }

  handleApiError(error) {
    if (error.response) {
      const { status, data } = error.response;
      const errorCode = data.errorCode || 'UNKNOWN_ERROR';
      const reason = data.reason || 'Unknown error occurred';
      
      logger.error(`[${SERVICE_NAME}] Bunjang API Error:`, {
        status,
        errorCode,
        reason,
        url: error.config.url
      });
      
      // 에러 코드별 처리
      switch (errorCode) {
        case 'PRODUCT_NOT_FOUND':
        case 'PRODUCT_SOLD_OUT':
        case 'PRODUCT_ON_HOLD':
          throw new ExternalServiceError(SERVICE_NAME, error, reason, errorCode, { recoverable: false });
        
        case 'INVALID_AUTH_TOKEN':
          throw new ExternalServiceError(SERVICE_NAME, error, 'Authentication failed', errorCode, { recoverable: false });
        
        case 'POINT_SHORTAGE':
        case 'INVALID_PRODUCT_PRICE':
          throw new ExternalServiceError(SERVICE_NAME, error, reason, errorCode, { recoverable: true });
        
        default:
          throw new ExternalServiceError(SERVICE_NAME, error, reason, errorCode);
      }
    }
    
    throw error;
  }
}

module.exports = BunjangOrderService;