import { test } from 'node:test';
import * as assert from 'node:assert';
import { TemplateConfigValidator, EnvironmentValidator } from './template.validation';
import type { TemplateConfig } from './template';

const validConfig: TemplateConfig = {
  domain: 'example.com',
  email: 'admin@example.com',
  profiles: ['profile1', 'profile2'],
};

test('TemplateConfigValidator', async (t) => {
  await t.test('should accept valid config', () => {
    assert.doesNotThrow(() => TemplateConfigValidator.validate(validConfig));
  });

  await t.test('should reject non-object config', () => {
    assert.throws(() => TemplateConfigValidator.validate(null), /Config must be an object/);
    assert.throws(() => TemplateConfigValidator.validate('string'), /Config must be an object/);
    assert.throws(() => TemplateConfigValidator.validate(123), /Config must be an object/);
  });

  await t.test('should reject missing domain', () => {
    const config = { ...validConfig };
    delete (config as Partial<TemplateConfig>).domain;
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.domain is required/);
  });

  await t.test('should reject invalid domain format', () => {
    const config = { ...validConfig, domain: '!invalid domain!' };
    assert.throws(() => TemplateConfigValidator.validate(config), /Invalid domain format/);
  });

  await t.test('should accept valid domain formats', () => {
    const validDomains = ['example.com', 'sub.example.com', 'example-123.com', 'a.co'];
    for (const domain of validDomains) {
      assert.doesNotThrow(() => TemplateConfigValidator.validate({ ...validConfig, domain }));
    }
  });

  await t.test('should reject missing email', () => {
    const config = { ...validConfig };
    delete (config as Partial<TemplateConfig>).email;
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.email is required/);
  });

  await t.test('should reject invalid email format', () => {
    const config = { ...validConfig, email: 'not-an-email' };
    assert.throws(() => TemplateConfigValidator.validate(config), /Invalid email format/);
  });

  await t.test('should reject missing profiles', () => {
    const config = { ...validConfig };
    delete (config as Partial<TemplateConfig>).profiles;
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.profiles must be/);
  });

  await t.test('should reject empty profiles array', () => {
    const config = { ...validConfig, profiles: [] };
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.profiles must be a non-empty array/);
  });

  await t.test('should reject profiles with non-string values', () => {
    const config = { ...validConfig, profiles: ['valid', 123 as any, null as any] };
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.profiles must contain only strings/);
  });

  await t.test('should accept optional cloudflare config', () => {
    const config: TemplateConfig = {
      ...validConfig,
      cloudflare: {
        apiToken: 'token123',
        zoneId: 'zone123',
      },
    };
    assert.doesNotThrow(() => TemplateConfigValidator.validate(config));
  });

  await t.test('should reject invalid cloudflare config', () => {
    const config: any = {
      ...validConfig,
      cloudflare: { apiToken: 123 },
    };
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.cloudflare.apiToken must be a string/);
  });

  await t.test('should accept optional authelia config', () => {
    const config: TemplateConfig = {
      ...validConfig,
      authelia: {
        jwtSecret: 'secret123',
        sessionSecret: 'session123',
        storageKey: 'storage123',
      },
    };
    assert.doesNotThrow(() => TemplateConfigValidator.validate(config));
  });

  await t.test('should reject invalid authelia config', () => {
    const config: any = {
      ...validConfig,
      authelia: { jwtSecret: 123 },
    };
    assert.throws(() => TemplateConfigValidator.validate(config), /Config.authelia.jwtSecret must be a string/);
  });
});

test('EnvironmentValidator', async (t) => {
  await t.test('should pass when all required vars are set', () => {
    process.env.TEST_VAR_1 = 'value1';
    process.env.TEST_VAR_2 = 'value2';
    assert.doesNotThrow(() => EnvironmentValidator.validateRequired(['TEST_VAR_1', 'TEST_VAR_2']));
    delete process.env.TEST_VAR_1;
    delete process.env.TEST_VAR_2;
  });

  await t.test('should throw when required vars are missing', () => {
    assert.throws(
      () => EnvironmentValidator.validateRequired(['MISSING_VAR_123']),
      /Missing required environment variables: MISSING_VAR_123/,
    );
  });

  await t.test('should list all missing variables', () => {
    assert.throws(() => EnvironmentValidator.validateRequired(['MISSING_1', 'MISSING_2', 'MISSING_3']), /MISSING/);
  });

  await t.test('should throw if PATH is not set', () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;
    assert.throws(() => EnvironmentValidator.validateDocker(), /PATH environment variable not set/);
    process.env.PATH = originalPath;
  });

  await t.test('should pass if PATH is set', () => {
    if (process.env.PATH) {
      assert.doesNotThrow(() => EnvironmentValidator.validateDocker());
    }
  });
});
