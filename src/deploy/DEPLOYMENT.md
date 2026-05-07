# Template Deployment Guide

## Overview

The `template.ts` module handles secure deployment of Docker Compose templates to remote servers via SSH. This document details the configuration, validation, and environment requirements.

## Configuration Requirements

### TemplateConfig Interface

All deployments require a valid `TemplateConfig` object with the following structure:

```typescript
interface TemplateConfig {
  domain: string;              // Required: valid domain name (e.g., example.com)
  email: string;               // Required: valid email address
  profiles: string[];          // Required: non-empty array of Docker Compose profiles
  cloudflare?: {               // Optional: Cloudflare DNS configuration
    apiToken: string;          // Cloudflare API token
    zoneId: string;            // Cloudflare Zone ID
  };
  authelia?: {                 // Optional: Authelia authentication configuration
    jwtSecret: string;         // JWT secret (generated if not provided)
    sessionSecret: string;     // Session secret (generated if not provided)
    storageKey: string;        // Storage encryption key (generated if not provided)
  };
  services?: Record<string, Record<string, string>>;  // Optional: service-specific config
}
```

## Validation

All configurations are validated before deployment using `TemplateConfigValidator`:

### Domain Validation
- Must be a valid DNS domain name
- Supports subdomains (e.g., `sub.example.com`)
- Supports hyphens (e.g., `example-123.com`)
- Cannot contain invalid characters or spaces

### Email Validation
- Must be a valid email format
- Required for Let's Encrypt certificate generation

### Profiles Validation
- Must be a non-empty array
- All entries must be strings
- Profiles map to Docker Compose service profiles

### Optional Configs
- CloudFlare credentials are validated as strings if provided
- Authelia secrets are validated as strings if provided
- All secrets are 32-byte hex strings if auto-generated

## Environment Variables

### Required Environment Variables

```bash
PATH                      # System PATH (for Docker and Git commands)
```

### Recommended Environment Variables

```bash
# Docker configuration
DOCKER_HOST              # Docker daemon socket (optional, uses default if not set)

# SSH configuration  
SSH_AUTH_SOCK            # SSH agent socket (for key-based authentication)

# Deployment target
TARGET_SERVER            # Remote server hostname or IP
TARGET_USER              # SSH user for remote server
TARGET_PORT              # SSH port (default: 22)
```

## Deployment Flow

### Pre-Deployment Validation

1. **Configuration Validation** - `TemplateConfigValidator.validate(config)`
   - Validates all required fields
   - Checks format constraints
   - Throws descriptive errors for invalid configs

2. **Environment Validation** - `EnvironmentValidator.validateDocker()`
   - Ensures Docker commands are available in PATH
   - Verifies SSH connectivity

### Deployment Steps

1. **Directory Setup** - Cleans and creates `/opt/docker`
2. **Template Cloning** - Clones Docker Compose template repository
3. **YAML Patching** - Neutralizes error handling in YAML files
4. **Environment File Generation** - Creates `.env` with all configuration
5. **Service Deployment** - Pulls and starts Docker Compose services

### Error Handling

- Invalid configurations fail fast with clear error messages
- SSH errors are caught and reported
- Command failures include exit codes and logs
- Sensitive data (passwords, tokens) is sanitized in all output

## WebSocket Communication

All deployment progress is streamed via WebSocket with message types:

```typescript
// Data output
{ type: "data", data: "command output..." }

// Status updates
{ type: "status", data: "Step description..." }

// Errors
{ type: "error", data: "Error message..." }
```

## Security Considerations

### Credential Management

1. **Auto-Generation** - Secrets are generated using `crypto.randomBytes(32)`
2. **Sanitization** - All passwords and secrets are masked in logs
3. **Base64 Encoding** - `.env` file is transmitted as base64 to avoid shell escaping issues

### Input Validation

- All user inputs (domain, email) are validated against strict regex patterns
- Optional configs are type-checked before use
- SSH commands are properly escaped to prevent injection

### WebSocket Safety

- WebSocket readyState is checked before sending
- Send failures are caught and logged without crashing
- Connection errors don't corrupt deployment state

## Testing

Run the test suite to validate the deployment logic:

```bash
# Run all template validation tests
node --test src/deploy/template.test.ts

# Run TypeScript type checks
npm run lint
```

### Test Coverage

- Valid configuration acceptance
- Invalid domain/email rejection
- Missing required field detection
- Optional config validation
- Environment variable verification
- Edge cases and malformed inputs

## Example Usage

```typescript
import { deployTemplate } from './src/deploy/template';
import { Client } from 'ssh2';
import { WebSocket } from 'ws';

const sshClient = new Client();
const ws = new WebSocket('ws://localhost:3000');

sshClient.connect({
  host: 'example.com',
  username: 'ubuntu',
  privateKey: require('fs').readFileSync('/path/to/key'),
});

ws.on('open', async () => {
  try {
    await deployTemplate({
      sshClient,
      ws,
      sudoPassword: 'password123',
      config: {
        domain: 'services.example.com',
        email: 'admin@example.com',
        profiles: ['core', 'media', 'monitoring'],
        cloudflare: {
          apiToken: process.env.CF_TOKEN!,
          zoneId: process.env.CF_ZONE!,
        },
      },
    });
  } catch (err) {
    console.error('Deployment failed:', err);
  }
});
```

## Troubleshooting

### Configuration Validation Errors

**Error:** `Invalid domain format`
- Solution: Ensure domain follows DNS naming conventions

**Error:** `Config.profiles must be a non-empty array`
- Solution: Provide at least one profile name as a string

### Deployment Errors

**Error:** `Missing required environment variables`
- Solution: Ensure SSH/Docker PATH is properly configured

**Error:** `DOCKER_NETWORK is missing a value`
- Solution: Add `DOCKER_NETWORK` to the `.env` generation in the template

### SSH Connection Errors

**Error:** `SSH Error: ...`
- Solution: Verify SSH credentials and server connectivity
- Check that the target server has Docker installed

## Contributing

When modifying `template.ts`:

1. Update type definitions in `TemplateConfig` if adding new config options
2. Add validation rules in `TemplateConfigValidator`
3. Add corresponding unit tests
4. Update this documentation
5. Run `npm run lint` to verify TypeScript
6. Run `node --test src/deploy/template.test.ts` to verify tests

## Performance Considerations

- Large template clones may take time depending on network speed
- Docker image pulls happen sequentially; consider profile selection
- Base64 encoding/decoding is negligible for typical `.env` file sizes
- WebSocket messages are buffered; streaming large logs is efficient
