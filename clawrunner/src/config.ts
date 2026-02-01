/**
 * Centralized Configuration for ClawRunner
 *
 * Loads and validates all environment variables at startup.
 * Import this module early to catch configuration errors immediately.
 */

interface ConfigValidationError {
  variable: string;
  message: string;
}

function getEnvVar(name: string, required: boolean = true): string | undefined {
  const value = process.env[name];
  if (required && !value) {
    return undefined; // Will be caught by validation
  }
  return value;
}

function validateConfig(): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Required variables
  if (!process.env.DATABASE_URL) {
    errors.push({
      variable: 'DATABASE_URL',
      message: 'PostgreSQL connection string is required',
    });
  }

  if (!process.env.NANGO_SECRET_KEY) {
    errors.push({
      variable: 'NANGO_SECRET_KEY',
      message: 'Nango secret key is required for OAuth',
    });
  }

  // Production-only requirements
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.FLY_API_TOKEN) {
      errors.push({
        variable: 'FLY_API_TOKEN',
        message: 'Fly.io API token is required in production',
      });
    }
  }

  return errors;
}

/**
 * Application configuration object.
 * Access configuration values through this object.
 */
export const config = {
  // Database
  database: {
    get url(): string {
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error('DATABASE_URL is not configured');
      }
      return url;
    },
  },

  // Nango OAuth
  nango: {
    get secretKey(): string {
      const key = process.env.NANGO_SECRET_KEY;
      if (!key) {
        throw new Error('NANGO_SECRET_KEY is not configured');
      }
      return key;
    },
    get host(): string | undefined {
      return process.env.NANGO_HOST;
    },
  },

  // Server
  server: {
    get port(): number {
      return parseInt(process.env.PORT || '3000', 10);
    },
    get nodeEnv(): string {
      return process.env.NODE_ENV || 'development';
    },
    get isProduction(): boolean {
      return this.nodeEnv === 'production';
    },
    get isDevelopment(): boolean {
      return this.nodeEnv === 'development';
    },
    get isTest(): boolean {
      return this.nodeEnv === 'test';
    },
  },

  // Fly.io
  fly: {
    get apiToken(): string | undefined {
      return process.env.FLY_API_TOKEN;
    },
    get appName(): string | undefined {
      return process.env.FLY_APP_NAME;
    },
    get region(): string | undefined {
      return process.env.FLY_REGION;
    },
  },
} as const;

/**
 * Validate configuration and throw if invalid.
 * Call this at application startup.
 */
export function assertConfigValid(): void {
  const errors = validateConfig();

  if (errors.length > 0) {
    const errorMessages = errors
      .map((e) => `  - ${e.variable}: ${e.message}`)
      .join('\n');

    throw new Error(
      `Configuration validation failed:\n${errorMessages}\n\nSee .env.example for required variables.`
    );
  }
}

/**
 * Check if configuration is valid without throwing.
 * Returns validation errors if any.
 */
export function checkConfig(): { valid: boolean; errors: ConfigValidationError[] } {
  const errors = validateConfig();
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get a summary of current configuration (with secrets redacted).
 * Useful for logging at startup.
 */
export function getConfigSummary(): Record<string, string | undefined> {
  return {
    DATABASE_URL: process.env.DATABASE_URL ? '[SET]' : '[NOT SET]',
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY ? '[SET]' : '[NOT SET]',
    NANGO_HOST: process.env.NANGO_HOST || '[DEFAULT]',
    PORT: process.env.PORT || '3000',
    NODE_ENV: process.env.NODE_ENV || 'development',
    FLY_API_TOKEN: process.env.FLY_API_TOKEN ? '[SET]' : '[NOT SET]',
    FLY_APP_NAME: process.env.FLY_APP_NAME || '[NOT SET]',
    FLY_REGION: process.env.FLY_REGION || '[NOT SET]',
  };
}
