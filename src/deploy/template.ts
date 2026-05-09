import { Client } from 'ssh2';
import { WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { TemplateConfigValidator, EnvironmentValidator } from './template.validation';

export interface TemplateConfig {
  domain: string;
  email: string;
  duckdnsToken?: string;
  profiles: string[];
  cloudflare?: {
    apiToken: string;
    zoneId: string;
  };
  authelia?: {
    jwtSecret: string;
    sessionSecret: string;
    storageKey: string;
  };
  services?: Record<string, Record<string, string>>;
}

export async function deployTemplate(params: {
  sshClient: Client;
  ws: WebSocket;
  sudoPassword: string;
  config: TemplateConfig;
}): Promise<void> {
  const { sshClient, ws, sudoPassword, config } = params;

  // ── WebSocket Safe Sender ─────────────────────────────────────────────
  const safeWsSend = (obj: any) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error("WebSocket send failed:", e);
    }
  };
  const log    = (msg: string) => safeWsSend({ type: "data",   data: `\r\n[DEPLOY] ${msg}\r\n` });
  const status = (msg: string) => safeWsSend({ type: "status", data: msg });
  const error  = (msg: string) => safeWsSend({ type: "error",  data: msg });

  // ── Input Validation ──────────────────────────────────────────────────
  const SAFE_DOMAIN  = /^[a-zA-Z0-9.-]+$/;
  const SAFE_EMAIL   = /^[a-zA-Z0-9.@_+-]+$/;
  const SAFE_PROFILE = /^[a-z0-9_-]+$/i;

  if (!SAFE_DOMAIN.test(config.domain)) {
    error(`Invalid domain format: ${config.domain}`);
    return;
  }
  if (!SAFE_EMAIL.test(config.email)) {
    error(`Invalid email format: ${config.email}`);
    return;
  }
  if (!config.profiles.every(p => SAFE_PROFILE.test(p))) {
    error("One or more selected profiles contain invalid characters.");
    return;
  }

  // DuckDNS validation: Ensure subdomain format if using duckdns.org
  if (config.domain.endsWith("duckdns.org")) {
    const parts = config.domain.split('.');
    if (parts.length < 3) {
      error("For DuckDNS, domain must be in the format 'subdomain.duckdns.org'");
      return;
    }
  }

  // ── Secret Sanitisers ─────────────────────────────────────────────────
  const buildSanitizers = () => {
    const sanitizers: Array<{ pattern: RegExp; replacement: string }> = [];
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (sudoPassword) sanitizers.push({ pattern: new RegExp(escape(sudoPassword), 'g'), replacement: '********' });
    return sanitizers;
  };
  const sanitizers = buildSanitizers();
  const sanitize = (text: string): string => {
    for (const s of sanitizers) text = text.replace(s.pattern, s.replacement);
    return text;
  };

  // ── Command Executor (REVERTED TO WORKING VERSION) ────────────────────
  const execCommand = (cmd: string, stepName: string, stopOnError = true): Promise<boolean> =>
    new Promise((resolve) => {
      log(`Executing: ${stepName}...`);
      const SUDO_PROMPT = "[kubecast-sudo-prompt]";
      // Back to basic bash execution so the sudo prompt is caught correctly
      const sudoCmd = `sudo -S -p "${SUDO_PROMPT}" bash -c "${cmd.replace(/"/g, '\\"')}"`;

      sshClient.exec(sudoCmd, { pty: true }, (err, stream) => {
        if (err) { error(`SSH Error: ${err.message}`); return resolve(false); }
        
        stream.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (text.includes(SUDO_PROMPT)) {
            stream.write(sudoPassword + "\n");
            return;
          }
          safeWsSend({ type: "data", data: sanitize(text) });
        });

        stream.on("close", (code: number) => {
          if (code === 0) resolve(true);
          else {
            if (stopOnError) { error(`Step ${stepName} failed code ${code}`); resolve(false); }
            else resolve(true);
          }
        });
      });
    });

  // ── Validate Configuration ─────────────────────────────────────────────
  try {
    TemplateConfigValidator.validate(config);
    EnvironmentValidator.validateDocker();
  } catch (validationErr: any) {
    error(`Configuration validation failed: ${validationErr.message}`);
    return;
  }

  try {
    // ── Step 1: Cleanup ────────────────────────────────────────────────
    status("Preparing directory...");
    await execCommand("rm -rf /opt/docker && mkdir -p /opt/docker", "Directory Reset");

    // ── Step 2: Clone and Apply Nuclear Patch ───────────────────────────
    status("Cloning and Patching Template...");
    // Build the Python patch script and encode it for safe transfer
    const pythonPatchScript = [
      `import os, re`,
      `path = 'apps/traefik/compose.yaml'`,
      `if not os.path.exists(path):`,
      `    exit(0)`,
      `with open(path, 'r') as f: content = f.read()`,
      ``,
      `# 0. Upgrade log level to DEBUG so ACME progress is visible in docker logs`,
      `content = content.replace('"--log.level=INFO"', '"--log.level=DEBUG"', 1)`,
      ``,
      `# 1. Ensure Cloudflare env vars are present`,
      `if 'CF_API_EMAIL' not in content:`,
      `    content = content.replace('environment:', 'environment:' + chr(10) + '      - CF_API_EMAIL=\${CF_API_EMAIL}' + chr(10) + '      - CF_DNS_API_TOKEN=\${CF_DNS_API_TOKEN}', 1)`,
      ``,
      `# 2. Remove DuckDNS env var`,
      `content = re.sub(r'^\\s*-\\s*DUCKDNS_TOKEN=.*$\\n?', '', content, flags=re.M)`,
      ``,
      `# 3. Replace TLS challenge with Cloudflare DNS-01 provider`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.tlschallenge=true"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', 1)`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', 1)`,
      ``,
      `# 4. Add delaybeforecheck=180 as its own distinct command entry`,
      `if 'delaybeforecheck' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', 1)`,
      `else:`,
      `    content = content.replace('delaybeforecheck=120', 'delaybeforecheck=180', 1)`,
      ``,
      `# 5. Add wildcard + apex SAN labels so LE issues a cert for BOTH *.domain AND domain`,
      `# The apex SAN is required; without it curl returns "unable to get local issuer certificate"`,
      `if 'tls.domains[0]' not in content:`,
      `    content = content.replace('"traefik.http.routers.api.tls.certresolver=letsencrypt"',`,
      `        '"traefik.http.routers.api.tls.certresolver=letsencrypt"' + chr(10)`,
      `        + '      - "traefik.http.routers.api.tls.domains[0].main=*.' + '\${DOMAIN}"' + chr(10)`,
      `        + '      - "traefik.http.routers.api.tls.domains[0].sans=' + '\${DOMAIN}"', 1)`,
      ``,
      `# 6. Add external DNS resolvers to avoid internal DNS caching issues`,
      `if 'dnschallenge.resolvers' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"', 1)`,
      ``,
      `# 7. Enable dynamic config file provider so we can set the default TLS store via YAML.`,
      `# --tls.stores.* are NOT valid CLI flags in Traefik v3; they must be in a dynamic config file.`,
      `if 'providers.file.filename' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"',`,
      `        '"--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"' + chr(10)`,
      `        + '      - "--providers.file.filename=/data/dynamic.yml"', 1)`,
      ``,
      `with open(path, 'w') as f: f.write(content)`,
      `print('Traefik patch applied.')`,
    ].join('\n');

    // Second script: replace tls.certresolver with tls=true for all non-Traefik app services.
    // This tells Traefik to use TLS but follow the default store's certificate (our wildcard)
    // instead of trying to generate a new cert per-service which can cause collisions or timeouts.
    const stripResolverScript = [
      `import os, re`,
      `apps_dir = 'apps'`,
      `for root, dirs, files in os.walk(apps_dir):`,
      `    if 'traefik' in root:`,
      `        continue`,
      `    for fname in files:`,
      `        if not fname.endswith('.yaml') and not fname.endswith('.yml'):`,
      `            continue`,
      `        fpath = os.path.join(root, fname)`,
      `        with open(fpath, 'r') as f: content = f.read()`,
      `        # Replace certresolver label with simple tls=true so they use the wildcard from the default store.`,
      `        # This regex is careful not to consume the closing quote or other surrounding characters.`,
      `        new_content = re.sub(r'(traefik\\\\.http\\\\.routers\\\\.[^.]+\\\\.tls)\\\\.certresolver=[^"\\\'\\\\s]+', r'\\\\1=true', content)`,
      `        if new_content != content:`,
      `            with open(fpath, 'w') as f: f.write(new_content)`,
      `            print('Updated TLS config for ' + fpath)`,
      `print('Service label update complete.')`,
    ].join('\n');

    const patchBase64 = Buffer.from(pythonPatchScript).toString('base64');
    const stripBase64 = Buffer.from(stripResolverScript).toString('base64');

    const cloneAndPatch = [
      `cd /opt/docker`,
      `git clone --depth 1 https://github.com/Viren070/docker-compose-template.git .`,
      `echo "${patchBase64}" | base64 -d > /tmp/patch_traefik.py`,
      `python3 /tmp/patch_traefik.py`,
      `rm -f /tmp/patch_traefik.py`,
      `echo "${stripBase64}" | base64 -d > /tmp/strip_resolver.py`,
      `python3 /tmp/strip_resolver.py`,
      `rm -f /tmp/strip_resolver.py`,
      `echo "Neuterizing YAMLs"`,
      `find . -type f \\( -name "*.yaml" -o -name "*.yml" \\) -exec sed -i 's/:?error/:-/g' {} +`,
      `find . -type f \\( -name "*.yaml" -o -name "*.yml" \\) -exec sed -i 's/:?err/:-/g' {} +`,
      `mkdir -p data/authelia apps`,
      `chown -R 1000:1000 /opt/docker`,
    ].join(' && ');

    
    if (!(await execCommand(cloneAndPatch, "Clone and Patch"))) return;
 
    // ── Step 2c: Configure Authelia Notifier (No SMTP) ──────────────────
    status("Configuring Authelia Notifier...");
    const autheliaPatch = [
      `import os, re`,
      `path = '/opt/docker/data/authelia/config/configuration.yml'`,
      `os.makedirs(os.path.dirname(path), exist_ok=True)`,
      `if not os.path.exists(path) and os.path.exists('/opt/docker/apps/authelia/configuration.yml'):`,
      `    import shutil`,
      `    shutil.copy('/opt/docker/apps/authelia/configuration.yml', path)`,
      `if os.path.exists(path):`,
      `    with open(path, 'r') as f: content = f.read()`,
      `    # Replace SMTP block with File notifier block`,
      `    pattern = r'notifier:\\s+smtp:.*?(\\n\\S|$)'`,
      `    replacement = 'notifier:\\n  file:\\n    path: /config/notification.txt\\n\\\\\\\\1'`,
      `    if 'notifier:' in content:`,
      `        if 'smtp:' in content:`,
      `            content = re.sub(pattern, replacement, content, flags=re.S)`,
      `        elif 'file:' not in content:`,
      `            content = content.replace('notifier:', 'notifier:\\n  file:\\n    path: /config/notification.txt', 1)`,
      `    else:`,
      `        content += \"\\nnotifier:\\n  file:\\n    path: /config/notification.txt\\n\"`,
      `    with open(path, 'w') as f: f.write(content)`,
      `    print('Authelia notifier set to file.')`,
    ].join('\n');
    const autheliaBase64 = Buffer.from(autheliaPatch).toString('base64');
    await execCommand(
      `echo "${autheliaBase64}" | base64 -d > /tmp/patch_authelia.py && python3 /tmp/patch_authelia.py && rm -f /tmp/patch_authelia.py`,
      "Patch Authelia Notifier"
    );

    // ── Step 2b: Reset acme.json + write dynamic.yml ─────────────────────
    status("Resetting acme.json and writing Traefik dynamic config...");
    await execCommand(
      `mkdir -p /opt/docker/data/traefik && rm -f /opt/docker/data/traefik/acme.json && touch /opt/docker/data/traefik/acme.json && chmod 600 /opt/docker/data/traefik/acme.json`,
      "Reset acme.json"
    );

    // Write the dynamic.yml that configures Traefik's default TLS store to serve the wildcard cert.
    // --tls.stores.* are dynamic-config-only in Traefik v3 (not valid CLI flags).
    // The defaultGeneratedCert block tells Traefik: use the letsencrypt resolver to obtain
    // *.domain + domain, and serve this wildcard as the default cert for ALL routers.
    // This eliminates the self-signed fallback for any service that has tls=true but no certresolver.
    const dynamicConfig = [
      `tls:`,
      `  stores:`,
      `    default:`,
      `      defaultGeneratedCert:`,
      `        resolver: letsencrypt`,
      `        domain:`,
      `          main: "*.${config.domain}"`,
      `          sans:`,
      `            - "${config.domain}"`,
    ].join("\n");
    const dynamicBase64 = Buffer.from(dynamicConfig).toString("base64");
    await execCommand(
      `echo "${dynamicBase64}" | base64 -d > /opt/docker/data/traefik/dynamic.yml`,
      "Write Traefik dynamic.yml"
    );

    // ── Step 3: Write .env ─────────────────────────────────────────────
    status("Writing root .env...");
    const genSecret = () => randomBytes(32).toString("hex");
    const jwtSecret     = config.authelia?.jwtSecret     || genSecret();
    const sessionSecret = config.authelia?.sessionSecret || genSecret();
    const storageKey    = config.authelia?.storageKey    || genSecret();

    const aiostreamsKey = randomBytes(32).toString("hex"); // 64 hex chars
    const generalKey    = randomBytes(32).toString("hex"); // 64 hex chars

    
    const envLines = [
      `TZ=Etc/UTC`,
      `DOCKER_DIR=/opt/docker`,
      `DOCKER_DATA_DIR=/opt/docker/data`,
      `DOCKER_APP_DIR=/opt/docker/apps`,
      `DOCKER_NETWORK=aio`,
      `PUID=1000`,
      `PGID=1000`,
      `DOMAIN=${config.domain}`,
      `LETSENCRYPT_EMAIL=${config.email}`,
      `CF_API_EMAIL=${config.email}`,
      `CF_DNS_API_TOKEN=${config.cloudflare?.apiToken || ''}`,
      `CLOUDFLARE_API_TOKEN=${config.cloudflare?.apiToken || ''}`,
      `CF_ZONE_ID=${config.cloudflare?.zoneId || ''}`,
      `COMPOSE_PROFILES=${config.profiles.join(",")}`,
      `COMPOSE_PROJECT_NAME=aio`,
      `COMPOSE_FILE=compose.yaml`,
      `LE_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory`,
      `TRUSTED_IPS=0.0.0.0/0,::/0`,
      `DOCKER_NETWORK_EXTERNAL=false`,
      `AUTHELIA_SESSION_SECRET=${sessionSecret}`,
      `AUTHELIA_STORAGE_ENCRYPTION_KEY=${storageKey}`,
      `AUTHELIA_JWT_SECRET=${jwtSecret}`,
      `ACTUAL_BUDGET_HOSTNAME=actual-budget.${config.domain}`,
      `ADDON_MANAGER_HOSTNAME=addon-manager.${config.domain}`,
      `ADGUARD_HOSTNAME=adguard.${config.domain}`,
      `AIOLISTS_HOSTNAME=aiolists.${config.domain}`,
      `AIOMANAGER_HOSTNAME=aiomanager.${config.domain}`,
      `AIOMETADATA_HOSTNAME=aiometadata.${config.domain}`,
      `AIOSTREAMS_HOSTNAME=aiostreams.${config.domain}`,
      `AIOSTREAMS_SECRET_KEY=${aiostreamsKey}`,
      `SECRET_KEY=${generalKey}`,
      `AIOSTREMIO_HOSTNAME=aiostremio.${config.domain}`,
      `ALTMOUNT_HOSTNAME=altmount.${config.domain}`,
      `ANIME_KITSU_HOSTNAME=kitsu.${config.domain}`,
      `APPRISE_HOSTNAME=apprise.${config.domain}`,
      `ARCANE_HOSTNAME=arcane.${config.domain}`,
      `AUTHELIA_HOSTNAME=auth.${config.domain}`,
      `AUTOSYNC_HOSTNAME=autosync.${config.domain}`,
      `BAZARR_HOSTNAME=bazarr.${config.domain}`,
      `BAZARR4K_HOSTNAME=4k.bazarr.${config.domain}`,
      `BASE_URL=https://aiostreams.${config.domain}`,
      `BESZEL_HOSTNAME=beszel.${config.domain}`,
      `BITMAGNET_HOSTNAME=bitmagnet.${config.domain}`,
      `CINEBYE_HOSTNAME=cinebye.${config.domain}`,
      `COMET_HOSTNAME=comet.${config.domain}`,
      `DASHDOT_HOSTNAME=dash.${config.domain}`,
      `DEBRIDAV_HOSTNAME=debridav.${config.domain}`,
      `DECYPHARR_HOSTNAME=decypharr.${config.domain}`,
      `DISCORD_TICKETS_HOSTNAME=tickets.${config.domain}`,
      `DOCKGE_HOSTNAME=dockge.${config.domain}`,
      `DOCKHAND_HOSTNAME=dockhand.${config.domain}`,
      `DOZZLE_HOSTNAME=dozzle.${config.domain}`,
      `EASYNEWS_PLUS_HOSTNAME=easynews-plus.${config.domain}`,
      `EASYNEWS_PLUS_PLUS_HOSTNAME=easynews-plus-plus.${config.domain}`,
      `FRESHRSS_HOSTNAME=freshrss.${config.domain}`,
      `FIVEFILTERS_FULL_TEXT_RSS_HOSTNAME=fivefilters.${config.domain}`,
      `HOMARR_HOSTNAME=homarr.${config.domain}`,
      `HONEY_HOSTNAME=${config.domain}`,
      `HOUND_HOSTNAME=hound.${config.domain}`,
      `HUNTARR_HOSTNAME=huntarr.${config.domain}`,
      `IMMICH_HOSTNAME=immich.${config.domain}`,
      `IPTVBOSS_HOSTNAME=iptvboss.${config.domain}`,
      `IT_TOOLS_HOSTNAME=it-tools.${config.domain}`,
      `JACKETT_HOSTNAME=jackett.${config.domain}`,
      `JACKETTIO_HOSTNAME=jackettio.${config.domain}`,
      `JELLYFIN_HOSTNAME=jellyfin.${config.domain}`,
      `KARAKEEP_HOSTNAME=karakeep.${config.domain}`,
      `LIBRESPEED_HOSTNAME=speedtest.${config.domain}`,
      `MEALIE_HOSTNAME=mealie.${config.domain}`,
      `MEDIAFLOW_PROXY_HOSTNAME=mediaflow-proxy.${config.domain}`,
      `MEDIAFUSION_HOSTNAME=mediafusion.${config.domain}`,
      `MINECRAFT_HOSTNAME=mc.${config.domain}`,
      `NITTER_HOSTNAME=nitter.${config.domain}`,
      `NOTIFIARR_HOSTNAME=notifiarr.${config.domain}`,
      `NTFY_HOSTNAME=ntfy.${config.domain}`,
      `NZBDAV_HOSTNAME=nzbdav.${config.domain}`,
      `NZBHYDRA2_HOSTNAME=nzbhydra2.${config.domain}`,
      `OMG_TV_STREMIO_ADDON_HOSTNAME=omg-tv-addon.${config.domain}`,
      `PLAUSIBLE_HOSTNAME=plausible.${config.domain}`,
      `PLEX_HOSTNAME=plex.${config.domain}`,
      `PLEXIO_HOSTNAME=plexio.${config.domain}`,
      `PORTAINER_HOSTNAME=portainer.${config.domain}`,
      `PROWLARR_HOSTNAME=prowlarr.${config.domain}`,
      `QUETRE_HOSTNAME=quetre.${config.domain}`,
      `RADARR_HOSTNAME=radarr.${config.domain}`,
      `RADARR4K_HOSTNAME=4k.radarr.${config.domain}`,
      `RADARRANIME_HOSTNAME=anime.radarr.${config.domain}`,
      `REDLIB_HOSTNAME=redlib.${config.domain}`,
      `RSS_BRIDGE_HOSTNAME=rss-bridge.${config.domain}`,
      `SEANIME_HOSTNAME=seanime.${config.domain}`,
      `SEARXNG_HOSTNAME=searxng.${config.domain}`,
      `SEERR_HOSTNAME=seerr.${config.domain}`,
      `SONARR_HOSTNAME=sonarr.${config.domain}`,
      `SONARR4K_HOSTNAME=4k.sonarr.${config.domain}`,
      `SONARRANIME_HOSTNAME=anime.sonarr.${config.domain}`,
      `SPEEDTEST_TRACKER_HOSTNAME=speedtest-tracker.${config.domain}`,
      `STIRLING_PDF_HOSTNAME=stirling.${config.domain}`,
      `STREAMYSTATS_HOSTNAME=streamystats.${config.domain}`,
      `STREMIO_ACCOUNT_BOOTSTRAPPER_HOSTNAME=stremio-account-bootstrapper.${config.domain}`,
      `STREMIO_AI_COMPANION_HOSTNAME=ai-companion.${config.domain}`,
      `STREMIO_AI_SEARCH_HOSTNAME=ai-search.${config.domain}`,
      `STREMIO_CATALOG_PROVIDERS_HOSTNAME=stremio-catalogues.${config.domain}`,
      `STREMIO_JACKETT_HOSTNAME=stremio-jackett.${config.domain}`,
      `STREMIO_LETTERBOXD_HOSTNAME=stremio-letterboxd.${config.domain}`,
      `STREMIO_SERVER_HOSTNAME=stremio-server.${config.domain}`,
      `STREMIO_STREAMING_CATALOGS_HOSTNAME=streaming-catalogs.${config.domain}`,
      `STREMIO_TRAKT_ADDON_HOSTNAME=stremio-trakt.${config.domain}`,
      `STREMTHRU_HOSTNAME=stremthru.${config.domain}`,
      `SYNCIO_HOSTNAME=syncio.${config.domain}`,
      `SYNCRIBULLET_HOSTNAME=syncribullet.${config.domain}`,
      `TANDOOR_HOSTNAME=tandoor.${config.domain}`,
      `TAUTULLI_HOSTNAME=tautulli.${config.domain}`,
      `THE_LOUNGE_HOSTNAME=thelounge.${config.domain}`,
      `TMDB_ADDON_HOSTNAME=tmdb.${config.domain}`,
      `TMDB_COLLECTIONS_HOSTNAME=tmdb-collections.${config.domain}`,
      `TORBOX_MANAGER_HOSTNAME=tbm.${config.domain}`,
      `TRAEFIK_HOSTNAME=traefik.${config.domain}`,
      `TULIPROX_HOSTNAME=tuliprox.${config.domain}`,
      `UPTIME_KUMA_HOSTNAME=status.${config.domain}`,
      `USENET_STREAMER_HOSTNAME=usenet-streamer.${config.domain}`,
      `USENET_ULTIMATE_HOSTNAME=usenet-ultimate.${config.domain}`,
      `VAULTWARDEN_HOSTNAME=vaultwarden.${config.domain}`,
      `WALLOS_HOSTNAME=wallos.${config.domain}`,
      `WEBSTREAMR_HOSTNAME=webstreamr.${config.domain}`,
      `WUD_HOSTNAME=wud.${config.domain}`,
      `XRDB_HOSTNAME=xrdb.${config.domain}`,
      `YAMTRACK_HOSTNAME=yamtrack.${config.domain}`,
      `ZILEAN_HOSTNAME=zilean.${config.domain}`,
      `ZIPLINE_HOSTNAME=zipline.${config.domain}`,
      `ZURG_HOSTNAME=zurg.${config.domain}`,
      
    ].join("\n");

    // Write .env using base64 encoding to avoid shell escaping issues
    const envBase64 = Buffer.from(envLines).toString("base64");
    await execCommand(`echo "${envBase64}" | base64 -d > /opt/docker/.env`, "Create .env");

    await execCommand(
    `python3 -c "lines=open('/opt/docker/.env').readlines();env=dict(l.strip().split('=',1) for l in lines if '=' in l);open('/opt/docker/apps/aiostreams/.env','w').write('SECRET_KEY='+env.get('AIOSTREAMS_SECRET_KEY','')+chr(10)+'BASE_URL=https://'+env.get('AIOSTREAMS_HOSTNAME','')+chr(10))"`,
    "Write aiostreams .env",
    false
    );

    await execCommand(
    `cat /opt/docker/apps/aiostreams/.env`,
    "Verify aiostreams .env",
    false
    );

  // ── Step 4: Pull & Start ───────────────────────────────────────────
  status("Deploying services...");
  await execCommand("cd /opt/docker && docker compose pull", "Docker Pull", false);
    
  const upSuccess = await execCommand("cd /opt/docker && docker compose up -d", "Docker Up");

  if (upSuccess) {
  status(`Success! Services accessible at https://${config.domain}`);
    } else {
      error("Deployment failed. Check docker logs.");
    }

  } catch (err: any) {
    error(`Fatal failure: ${err.message}`);
  }
}
