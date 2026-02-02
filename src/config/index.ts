/**
 * Application Configuration
 * All configuration is loaded from environment variables
 * No secrets are ever hardcoded
 *
 * PRODUCTION: All secrets are REQUIRED - no defaults
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env file
dotenv.config();

const isProduction = process.env['NODE_ENV'] === 'production';

// Production schema - all secrets required
const productionEnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required in production'),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // Authentication - REQUIRED in production
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must be at least 64 characters in production'),
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN must be at least 32 characters in production'),

  // HTTP Basic Auth - extra layer of protection
  BASIC_AUTH_USER: z.string().min(1, 'BASIC_AUTH_USER is required in production'),
  BASIC_AUTH_PASS: z.string().min(16, 'BASIC_AUTH_PASS must be at least 16 characters'),

  // Google Ads API
  GOOGLE_ADS_STUB_MODE: z.coerce.boolean().default(true),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),

  // Merchant Center
  MERCHANT_CENTER_ID: z.string().optional(),

  // Email Notifications
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  NOTIFICATION_FROM: z.string().optional(),
  NOTIFICATION_TO: z.string().optional(),

  // Slack (optional)
  SLACK_WEBHOOK_URL: z.string().optional(),

  // Application
  NODE_ENV: z.literal('production'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('warn'),

  // Trusted proxy (for running behind nginx)
  TRUST_PROXY: z.coerce.boolean().default(true),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),

  // Kill switch default
  KILL_SWITCH_ENABLED: z.coerce.boolean().default(false),
});

// Development schema - defaults allowed
const developmentEnvSchema = z.object({
  // Database - support both DATABASE_URL and individual params
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('alphabet_trains'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // Authentication - defaults for dev only
  JWT_SECRET: z.string().min(32).default('dev-jwt-secret-change-in-production-min32chars'),
  ADMIN_TOKEN: z.string().min(16).default('dev-admin-token-16'),

  // HTTP Basic Auth - optional in dev
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASS: z.string().optional(),

  // Google Ads API
  GOOGLE_ADS_STUB_MODE: z.coerce.boolean().default(true),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),

  // Merchant Center
  MERCHANT_CENTER_ID: z.string().optional(),

  // Email Notifications
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  NOTIFICATION_FROM: z.string().optional(),
  NOTIFICATION_TO: z.string().optional(),

  // Slack (optional)
  SLACK_WEBHOOK_URL: z.string().optional(),

  // Application
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  TRUST_PROXY: z.coerce.boolean().default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(1000),

  // Kill switch default
  KILL_SWITCH_ENABLED: z.coerce.boolean().default(false),
});

function loadConfig() {
  const schema = isProduction ? productionEnvSchema : developmentEnvSchema;
  const result = schema.safeParse(process.env);

  if (!result.success) {
    console.error('========================================');
    console.error('CONFIGURATION ERROR');
    console.error('========================================');
    if (isProduction) {
      console.error('Production mode requires all secrets to be set.');
      console.error('See .env.production.example for required variables.');
    }
    console.error(result.error.format());
    throw new Error('Configuration validation failed');
  }

  const env = result.data;

  // Build DATABASE_URL from individual params if not provided (dev only)
  let databaseUrl: string;
  if ('DATABASE_URL' in env && env.DATABASE_URL) {
    databaseUrl = env.DATABASE_URL;
  } else if ('DB_USER' in env) {
    const devEnv = env as z.infer<typeof developmentEnvSchema>;
    databaseUrl = `postgresql://${devEnv.DB_USER}${devEnv.DB_PASSWORD ? ':' + devEnv.DB_PASSWORD : ''}@${devEnv.DB_HOST}:${devEnv.DB_PORT}/${devEnv.DB_NAME}`;
  } else {
    throw new Error('DATABASE_URL is required');
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,

    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    },

    database: {
      url: databaseUrl,
      poolMin: env.DATABASE_POOL_MIN,
      poolMax: env.DATABASE_POOL_MAX,
    },

    googleAds: {
      stubMode: env.GOOGLE_ADS_STUB_MODE,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId: env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
      customerId: env.GOOGLE_ADS_CUSTOMER_ID,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      isConfigured: Boolean(
        env.GOOGLE_ADS_DEVELOPER_TOKEN &&
        env.GOOGLE_ADS_CLIENT_ID &&
        env.GOOGLE_ADS_REFRESH_TOKEN &&
        env.GOOGLE_ADS_CUSTOMER_ID
      ),
    },

    merchantCenter: {
      merchantId: env.MERCHANT_CENTER_ID,
      isConfigured: Boolean(env.MERCHANT_CENTER_ID),
    },

    auth: {
      jwtSecret: env.JWT_SECRET,
      adminToken: env.ADMIN_TOKEN,
      basicAuth: env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS ? {
        user: env.BASIC_AUTH_USER,
        pass: env.BASIC_AUTH_PASS,
      } : null,
    },

    notifications: {
      email: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.NOTIFICATION_FROM,
        to: env.NOTIFICATION_TO,
        isConfigured: Boolean(env.SMTP_HOST && env.SMTP_USER && env.NOTIFICATION_TO),
      },
      slack: {
        webhookUrl: env.SLACK_WEBHOOK_URL,
        isConfigured: Boolean(env.SLACK_WEBHOOK_URL),
      },
    },

    killSwitchDefault: env.KILL_SWITCH_ENABLED,
  };
}

export const config = loadConfig();
export type Config = typeof config;
