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
  const SAFE_DOMAIN  = /^[a-zA-Z0-9._-]+$/;
  const SAFE_EMAIL   = /^[a-zA-Z0-9.@_+-]+$/;

  if (!SAFE_DOMAIN.test(config.domain) || !SAFE_EMAIL.test(config.email)) {
    error("Invalid domain or email format.");
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
      `# 1. Remove Cloudflare env vars`,
      `content = re.sub(r'^\\s*-\\s*CF_API_EMAIL=.*$\\n?', '', content, flags=re.M)`,
      `content = re.sub(r'^\\s*-\\s*CF_DNS_API_TOKEN=.*$\\n?', '', content, flags=re.M)`,
      ``,
      `# 2. Add DUCKDNS_TOKEN to environment block`,
      `if 'DUCKDNS_TOKEN' not in content:`,
      `    content = content.replace('environment:', 'environment:' + chr(10) + '      - DUCKDNS_TOKEN=\${DUCKDNS_TOKEN}', 1)`,
      ``,
      `# 3. Replace TLS challenge with DuckDNS DNS-01 provider`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.tlschallenge=true"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"', 1)`,
      `content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"', 1)`,
      ``,
      `# 4. Add delaybeforecheck=180 as its own distinct command entry`,
      `if 'delaybeforecheck' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=duckdns"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', 1)`,
      `else:`,
      `    content = content.replace('delaybeforecheck=120', 'delaybeforecheck=180', 1)`,
      ``,
      `# 5. Add wildcard domain labels for a single cert covering *.domain`,
      `if 'tls.domains[0]' not in content:`,
      `    content = content.replace('"traefik.http.routers.api.tls.certresolver=letsencrypt"', '"traefik.http.routers.api.tls.certresolver=letsencrypt"' + chr(10) + '      - "traefik.http.routers.api.tls.domains[0].main=*.' + '\${DOMAIN}"', 1)`,
      ``,
      `# 6. Add external DNS resolvers to avoid internal DNS caching issues`,
      `if 'dnschallenge.resolvers' not in content:`,
      `    content = content.replace('"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"', '"--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=180"' + chr(10) + '      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"', 1)`,
      ``,
      `with open(path, 'w') as f: f.write(content)`,
      `print('Traefik patch applied.')`,
    ].join('\n');

    // Second script: strip tls.certresolver from all non-Traefik app services
    // so Traefik only challenges the wildcard, not every subdomain individually
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
      `        # Remove any tls.certresolver label from non-Traefik services`,
      `        new_content = re.sub(r'^\\s*-\\s*"traefik\\.http\\.routers\\.[^.]+\\.tls\\.certresolver=.*"\\s*$\\n?', '', content, flags=re.M)`,
      `        if new_content != content:`,
      `            with open(fpath, 'w') as f: f.write(new_content)`,
      `            print('Stripped certresolver from ' + fpath)`,
      `print('Service label cleanup complete.')`,
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

    // ── Step 2b: Reset acme.json for a fresh cert request ───────────────
    status("Resetting acme.json...");
    await execCommand(
      `mkdir -p /opt/docker/data/traefik && rm -f /opt/docker/data/traefik/acme.json && touch /opt/docker/data/traefik/acme.json && chmod 600 /opt/docker/data/traefik/acme.json`,
      "Reset acme.json"
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
      `COMPOSE_PROFILES=${config.profiles.join(",")}`,
      `COMPOSE_PROJECT_NAME=aio`,
      `COMPOSE_FILE=compose.yaml`,
      `DUCKDNS_TOKEN=${config.duckdnsToken || ''}`,
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
      `DOZZLE_HOSTNAME=dozzle.${config.domain}`,
      `EASYNEWS_PLUS_HOSTNAME=easynews-plus.${config.domain}`,
      `EASYNEWS_PLUS_PLUS_HOSTNAME=easynews-plus-plus.${config.domain}`,
      `FRESHRSS_HOSTNAME=freshrss.${config.domain}`,
      `FIVEFILTERS_FULL_TEXT_RSS_HOSTNAME=fivefilters.${config.domain}`,
      `HOMARR_HOSTNAME=homarr.${config.domain}`,
      `HONEY_HOSTNAME=${config.domain}`,
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
      `UPTIME_KUMA_HOSTNAME=status.${config.domain}`,
      `USENET_STREAMER_HOSTNAME=usenet-streamer.${config.domain}`,
      `VAULTWARDEN_HOSTNAME=vaultwarden.${config.domain}`,
      `WALLOS_HOSTNAME=wallos.${config.domain}`,
      `WEBSTREAMR_HOSTNAME=webstreamr.${config.domain}`,
      `WUD_HOSTNAME=wud.${config.domain}`,
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
