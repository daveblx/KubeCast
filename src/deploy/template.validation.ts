import { TemplateConfig } from './template';

/**
 * Validates TemplateConfig object before deployment
 * Ensures all required fields are present and properly formatted
 */
export class TemplateConfigValidator {
  private static readonly DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  static validate(config: unknown): config is TemplateConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be an object');
    }

    const cfg = config as Record<string, unknown>;

    // Validate domain
    if (!cfg.domain || typeof cfg.domain !== 'string') {
      throw new Error('Config.domain is required and must be a string');
    }
    if (!this.DOMAIN_REGEX.test(cfg.domain)) {
      throw new Error(`Invalid domain format: ${cfg.domain}`);
    }

    // Validate email
    if (!cfg.email || typeof cfg.email !== 'string') {
      throw new Error('Config.email is required and must be a string');
    }
    if (!this.EMAIL_REGEX.test(cfg.email)) {
      throw new Error(`Invalid email format: ${cfg.email}`);
    }

    // Validate profiles
    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
      throw new Error('Config.profiles must be a non-empty array of strings');
    }
    if (!cfg.profiles.every((p) => typeof p === 'string')) {
      throw new Error('Config.profiles must contain only strings');
    }

    // Validate optional cloudflare config
    if (cfg.cloudflare) {
      if (typeof cfg.cloudflare !== 'object') {
        throw new Error('Config.cloudflare must be an object if provided');
      }
      const cf = cfg.cloudflare as Record<string, unknown>;
      if (cf.apiToken && typeof cf.apiToken !== 'string') {
        throw new Error('Config.cloudflare.apiToken must be a string');
      }
      if (cf.zoneId && typeof cf.zoneId !== 'string') {
        throw new Error('Config.cloudflare.zoneId must be a string');
      }
    }

    // Validate optional authelia config
    if (cfg.authelia) {
      if (typeof cfg.authelia !== 'object') {
        throw new Error('Config.authelia must be an object if provided');
      }
      const auth = cfg.authelia as Record<string, unknown>;
      if (auth.jwtSecret && typeof auth.jwtSecret !== 'string') {
        throw new Error('Config.authelia.jwtSecret must be a string');
      }
      if (auth.sessionSecret && typeof auth.sessionSecret !== 'string') {
        throw new Error('Config.authelia.sessionSecret must be a string');
      }
      if (auth.storageKey && typeof auth.storageKey !== 'string') {
        throw new Error('Config.authelia.storageKey must be a string');
      }
    }

    return true;
  }
}

/**
 * Validates environment variables required for deployment
 */
export class EnvironmentValidator {
  static validateRequired(vars: string[]): void {
    const missing: string[] = [];
    for (const varName of vars) {
      if (!process.env[varName]) {
        missing.push(varName);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  static validateDocker(): void {
    // Check if docker commands would be available
    if (!process.env.PATH) {
      throw new Error('PATH environment variable not set');
    }
  }
}
