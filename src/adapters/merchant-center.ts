/**
 * Google Merchant Center Adapter (Stub)
 * Interface for Merchant Center diagnostics
 *
 * This is a stub implementation - integrate with Content API when available
 */

import { config } from '../config/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ProductStatus {
  product_id: string;
  title: string;
  status: 'active' | 'disapproved' | 'pending' | 'expiring';
  issues: ProductIssue[];
  availability: 'in stock' | 'out of stock' | 'preorder';
  price_micros: bigint;
  currency: string;
}

export interface ProductIssue {
  severity: 'error' | 'warning' | 'suggestion';
  code: string;
  description: string;
  affected_attribute?: string;
}

export interface MerchantDiagnostics {
  total_products: number;
  active_products: number;
  disapproved_products: number;
  pending_products: number;
  expiring_products: number;
  top_issues: {
    code: string;
    count: number;
    severity: 'error' | 'warning';
  }[];
  data_freshness_hours: number;
}

// ============================================================================
// INTERFACE
// ============================================================================

export interface IMerchantCenterAdapter {
  getDiagnostics(): Promise<MerchantDiagnostics>;
  getProductStatuses(limit?: number): Promise<ProductStatus[]>;
  getProductById(productId: string): Promise<ProductStatus | null>;
  isStub(): boolean;
}

// ============================================================================
// STUB IMPLEMENTATION
// ============================================================================

class MerchantCenterStub implements IMerchantCenterAdapter {
  private mockProducts: ProductStatus[] = [];

  constructor() {
    // Initialize with sample products
    this.mockProducts = [
      {
        product_id: 'prod_001',
        title: 'Wooden Train Set - Classic',
        status: 'active',
        issues: [],
        availability: 'in stock',
        price_micros: BigInt(49_990_000), // $49.99
        currency: 'USD',
      },
      {
        product_id: 'prod_002',
        title: 'Electric Train Starter Kit',
        status: 'active',
        issues: [
          {
            severity: 'warning',
            code: 'image_quality',
            description: 'Image resolution is below recommended',
            affected_attribute: 'image_link',
          },
        ],
        availability: 'in stock',
        price_micros: BigInt(129_990_000), // $129.99
        currency: 'USD',
      },
      {
        product_id: 'prod_003',
        title: 'Train Track Expansion Pack',
        status: 'pending',
        issues: [],
        availability: 'in stock',
        price_micros: BigInt(29_990_000), // $29.99
        currency: 'USD',
      },
    ];
  }

  async getDiagnostics(): Promise<MerchantDiagnostics> {
    const active = this.mockProducts.filter((p) => p.status === 'active').length;
    const pending = this.mockProducts.filter((p) => p.status === 'pending').length;
    const disapproved = this.mockProducts.filter((p) => p.status === 'disapproved').length;
    const expiring = this.mockProducts.filter((p) => p.status === 'expiring').length;

    return {
      total_products: this.mockProducts.length,
      active_products: active,
      disapproved_products: disapproved,
      pending_products: pending,
      expiring_products: expiring,
      top_issues: [
        { code: 'image_quality', count: 1, severity: 'warning' },
      ],
      data_freshness_hours: 2,
    };
  }

  async getProductStatuses(limit = 100): Promise<ProductStatus[]> {
    return this.mockProducts.slice(0, limit);
  }

  async getProductById(productId: string): Promise<ProductStatus | null> {
    return this.mockProducts.find((p) => p.product_id === productId) ?? null;
  }

  isStub(): boolean {
    return true;
  }
}

// ============================================================================
// REAL IMPLEMENTATION (Placeholder)
// ============================================================================

class MerchantCenterClient implements IMerchantCenterAdapter {
  private merchantId: string;

  constructor(merchantId: string) {
    this.merchantId = merchantId;
  }

  async getDiagnostics(): Promise<MerchantDiagnostics> {
    // TODO: Implement using Content API
    // For now, return stub data
    console.warn('Merchant Center real implementation not yet available');
    const stub = new MerchantCenterStub();
    return stub.getDiagnostics();
  }

  async getProductStatuses(limit = 100): Promise<ProductStatus[]> {
    // TODO: Implement using Content API
    console.warn('Merchant Center real implementation not yet available');
    const stub = new MerchantCenterStub();
    return stub.getProductStatuses(limit);
  }

  async getProductById(productId: string): Promise<ProductStatus | null> {
    // TODO: Implement using Content API
    console.warn('Merchant Center real implementation not yet available');
    const stub = new MerchantCenterStub();
    return stub.getProductById(productId);
  }

  isStub(): boolean {
    // Even though we have config, implementation is not complete
    return true;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMerchantCenterAdapter(): IMerchantCenterAdapter {
  if (config.merchantCenter.isConfigured && config.merchantCenter.merchantId) {
    console.log('Merchant Center configured (using partial implementation)');
    return new MerchantCenterClient(config.merchantCenter.merchantId);
  } else {
    console.log('Merchant Center not configured, using stub');
    return new MerchantCenterStub();
  }
}

// Singleton instance
let adapterInstance: IMerchantCenterAdapter | null = null;

export function getMerchantCenterAdapter(): IMerchantCenterAdapter {
  if (!adapterInstance) {
    adapterInstance = createMerchantCenterAdapter();
  }
  return adapterInstance;
}
