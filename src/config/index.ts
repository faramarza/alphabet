/**
 * Application Configuration
 * All configuration is loaded from environment variables
 * No secrets are ever hardcoded
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env file in development
dotenv.config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // Google Ads API
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),

  // Merchant Center
  MERCHANT_CENTER_ID: z.string().optional(),

  // Authentication
  JWT_SECRET: z.string().min(32),
  ADMIN_TOKEN: z.string().min(16),

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
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Kill switch default
  KILL_SWITCH_ENABLED: z.coerce.boolean().default(false),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    throw new Error('Configuration validation failed');
  }

  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,

    database: {
      url: env.DATABASE_URL,
      poolMin: env.DATABASE_POOL_MIN,
      poolMax: env.DATABASE_POOL_MAX,
    },

    googleAds: {
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
