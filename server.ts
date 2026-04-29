import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import fs from "fs";
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";

const upload = multer({ dest: "/tmp" });

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(process.cwd(), "db.json");

// Ensure sync DB for simple state
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ servers: [], clusters: [] }));
}

function getDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db: any) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── FIX #3 (High): Allowed commands allowlist for /exec ─────────────────────
// CodeQL "Uncontrolled command line": only permit a known-safe set of commands.
const ALLOWED_EXEC_COMMANDS = new Set([
  "df -h",
  "free -m",
  "uptime",
  "whoami",
  "hostname",
  "uname -a",
  "docker ps",
  "docker ps -a",
  "docker images",
  "docker stats --no-stream",
  "kubectl get nodes",
  "kubectl get pods",
  "kubectl get pods -A",
  "kubectl get services",
  "k3s kubectl get nodes",
  "k3s kubectl get pods",
  "systemctl status docker",
  "systemctl status k3s",
]);

// ─── FIX #6 (High): Safe remote path validator ────────────────────────────────
// CodeQL "Uncontrolled data used in path expression": resolve and prefix-check.
function safePosixPath(userInput: string, username: string): string | null {
  if (!userInput || typeof userInput !== "string") return null;
  const normalized = path.posix.normalize(userInput);
  // Must start with /tmp/ or /home/<username>/
  const allowed = [`/tmp/`, `/home/${username}/`];
  for (const prefix of allowed) {
    if (normalized.startsWith(prefix)) return normalized;
  }
  return null;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());
  app.use(limiter);

  // Server Management API
  app.get("/api/servers", (req, res) => {
    const db = getDB();
    // Strip passwords before sending to frontend
    const sanitized = db.servers.map(({ password, ...rest }: any) => rest);
    res.json(sanitized);
  });

  app.post("/api/servers", (req, res) => {
    const { name, host, username, port, password } = req.body;

    if (!name || !host || !username) {
      return res.status(400).json({ error: "name, host, and username are required" });
    }

    const db = getDB();
    const newServer = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      host,
      username,
      port: port || 22,
      password: password || "",
      status: "offline",
      installed: { docker: false, k8s: false },
    };
    db.servers.push(newServer);
    saveDB(db);
    // Return without password
    const { password: _, ...sanitized } = newServer;
    res.json(sanitized);
  });

  app.delete("/api/servers/:id", (req, res) => {
    const db = getDB();
    db.servers = db.servers.filter((s: any) => s.id !== req.params.id);
    saveDB(db);
    res.status(204).end();
  });

  // --- Basic Server CRUD ---
  app.get("/api/servers/:id", (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    const { password, ...sanitized } = server;
    res.json(sanitized);
  });

  app.put("/api/servers/:id", (req, res) => {
    const db = getDB();
    const idx = db.servers.findIndex((s: any) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Server not found" });
    db.servers[idx] = { ...db.servers[idx], ...req.body };
    saveDB(db);
    const { password, ...sanitized } = db.servers[idx];
    res.json(sanitized);
  });

  // --- DevOps: Upload and Execute Script ---
  // FIX #4 & #5 (High): "Uncontrolled data used in path expression"
  // remotePath is now validated against an allowlist of safe prefixes before use.
  app.post("/api/servers/:id/upload", upload.single("file"), (req: any, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // FIX: Validate local temp path before reading
    if (!req.file.path.startsWith("/tmp/")) {
      return res.status(400).json({ error: "Invalid local file path" });
    }

    // FIX: Validate the remote path against safe prefixes — and use path.basename to untaint req.file.originalname
    const safeOriginalName = path.basename(req.file.originalname);
    const rawRemotePath = req.body.remotePath || `/tmp/${safeOriginalName}`;
    const sanitizedRemotePath = safePosixPath(rawRemotePath, server.username);
    if (!sanitizedRemotePath) {
      // Untaint the path for unlinkSync by using basename if it starts with /tmp/
      const localPath = req.file.path.startsWith("/tmp/") ? path.join("/tmp", path.basename(req.file.path)) : null;
      if (localPath) fs.unlinkSync(localPath);
      return res.status(400).json({
        error: "Remote path must be within /tmp/ or /home/<username>/",
      });
    }

    // Untaint local path for stream
    const safeLocalPath = path.join("/tmp", path.basename(req.file.path));

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) {
            conn.end();
            return res.status(500).json({ error: err.message });
          }

          const readStream = fs.createReadStream(safeLocalPath);
          const writeStream = sftp.createWriteStream(sanitizedRemotePath);
          writeStream.on("close", () => {
            conn.end();
            fs.unlinkSync(safeLocalPath);
            res.json({ remotePath: sanitizedRemotePath });
          });
          writeStream.on("error", (err: any) => {
            conn.end();
            fs.unlinkSync(safeLocalPath);
            res.status(500).json({ error: err.message });
          });
          readStream.pipe(writeStream);
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  // --- DevOps: Destructive Server Wipe ---
  // FIX #1 (Critical): "Uncontrolled command line"
  // The destroy command is now fully hardcoded — no user input is interpolated.
  // Password is injected via stdin to sudo -S, never embedded in the command string.
  app.post("/api/servers/:id/destroy", (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        // All commands are fully hardcoded — zero user-controlled data
        const destroyCmd = [
          'echo "Initiating nuclear cleanup..."',
          "sudo -S -p '' -v",
          "sudo /usr/local/bin/k3s-uninstall.sh || true",
          "sudo /usr/local/bin/k3s-agent-uninstall.sh || true",
          "sudo docker stop $(sudo docker ps -aq) || true",
          "sudo docker rm $(sudo docker ps -aq) || true",
          "sudo docker system prune -af --volumes || true",
          "sudo apt-get purge -y docker-engine docker docker.io docker-ce docker-ce-cli containerd containerd.io || sudo yum remove -y docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine || true",
          "sudo rm -rf /var/lib/docker /etc/docker /var/lib/containerd /var/run/docker.sock /var/lib/rancher /etc/rancher ~/.kube || true",
          'echo "Cleanup complete. System is clean."',
        ].join(" ; ");

        conn.exec(destroyCmd, (err, stream) => {
          if (err) {
            conn.end();
            return res.status(500).json({ error: err.message });
          }

          // Password fed to sudo -S via stdin — never interpolated into the command
          stream.write(server.password + "\n");

          let output = "";
          stream.on("data", (data: any) => (output += data.toString()));
          stream.stderr.on("data", (data: any) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const dbAfter = getDB();
            dbAfter.servers = dbAfter.servers.filter((s: any) => s.id !== req.params.id);
            saveDB(dbAfter);
            res.json({ success: true, log: output });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  // --- DevOps: Remote Command Execution ---
  // FIX #2 (Critical): "Uncontrolled command line"
  // Only commands from an explicit allowlist are accepted.
  // This is the only CodeQL-safe approach — taint tracking cannot be satisfied
  // by sanitization alone when data flows into exec().
  app.post("/api/servers/:id/exec", (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const { command } = req.body;
    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "Missing or invalid command" });
    }

    // FIX: Reject anything not on the allowlist — fetch FROM allowlist to break taint
    const safeCommand = [...ALLOWED_EXEC_COMMANDS].find(c => c === command.trim());
    if (!safeCommand) {
      return res.status(403).json({
        error: "Command not permitted. Use one of the allowed commands.",
        allowed: [...ALLOWED_EXEC_COMMANDS],
      });
    }

    const conn = new Client();
    let output = "";
    let error = "";
    conn
      .on("ready", () => {
        conn.exec(safeCommand, (err, stream) => {
          if (err) {
            conn.end();
            return res.status(500).json({ error: err.message });
          }
          stream.on("data", (data) => (output += data.toString()));
          stream.stderr.on("data", (data) => (error += data.toString()));
          stream.on("close", (code) => {
            conn.end();
            res.json({ code, output, error });
          });
        });
      })
      .on("error", (err) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  // --- DevOps: Deploy Custom Dockerfile ---
  // FIX #3 (Critical): "Uncontrolled command line"
  // dockerfile content is written to a local temp file and SFTPed over,
  // never embedded in a shell string. portMapping and containerName are
  // strictly validated before use.
  app.post("/api/servers/:id/deploy-dockerfile", (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const { dockerfile, containerName, portMapping } = req.body;
    if (!dockerfile || !containerName || typeof containerName !== 'string') {
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    // Strict container name: whitelist filter to break CodeQL taint chain
    const safeContainerName = containerName.toLowerCase()
      .split('')
      .filter(c => 'abcdefghijklmnopqrstuvwxyz0123456789-_'.includes(c))
      .join('');
    
    if (!safeContainerName || safeContainerName.length > 64 || safeContainerName !== containerName.toLowerCase()) {
      return res.status(400).json({ error: "Invalid container name. Only lowercase alphanumeric, hyphens, and underscores allowed." });
    }

    // Port mapping: strict whitelist filter
    let safePortFlag = "";
    if (portMapping) {
      const p = String(portMapping).trim();
      const safeP = p.split('').filter(c => '0123456789:'.includes(c)).join('');
      if (safeP !== p || !/^\d{1,5}:\d{1,5}$/.test(safeP)) {
        return res.status(400).json({ error: "Invalid port mapping format. Use HOST:CONTAINER (e.g. 8080:80)" });
      }
      safePortFlag = `-p ${safeP}`;
    }

    // FIX: Write Dockerfile to a local temp file and SFTP it to the server.
    // This avoids embedding user-controlled dockerfile content in any shell string.
    const localTmpPath = `/tmp/kubecast-dockerfile-${Date.now()}`;
    try {
      fs.writeFileSync(localTmpPath, dockerfile);
    } catch (e: any) {
      return res.status(500).json({ error: "Failed to write temp Dockerfile: " + e.message });
    }

    const workDir = `/tmp/kubecast-deploy-${safeContainerName}-${Date.now()}`;

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) {
            conn.end();
            fs.unlinkSync(localTmpPath);
            return res.status(500).json({ error: err.message });
          }

          // First: create working directory via exec (hardcoded path, no user input)
          conn.exec(`mkdir -p ${workDir}`, (mkErr, mkStream) => {
            if (mkErr) {
              conn.end();
              fs.unlinkSync(localTmpPath);
              return res.status(500).json({ error: mkErr.message });
            }
            mkStream.on("close", () => {
              // SFTP the Dockerfile — no shell interpolation of its contents
              const remoteDockerfile = `${workDir}/Dockerfile`;
              const readStream = fs.createReadStream(localTmpPath);
              const writeStream = sftp.createWriteStream(remoteDockerfile);

              writeStream.on("close", () => {
                fs.unlinkSync(localTmpPath);

                // Now build and run — only safeContainerName and safePortFlag
                // are interpolated; both are strictly validated above.
                const buildAndRun = [
                  `docker build -t ${safeContainerName} ${workDir}`,
                  `docker rm -f ${safeContainerName} 2>/dev/null || true`,
                  `docker run -d --name ${safeContainerName} ${safePortFlag} ${safeContainerName}`,
                  `rm -rf ${workDir}`,
                ].join(" && ");

                const script = `sudo -S -p '' bash -c '${buildAndRun}'`;
                conn.exec(script, (execErr, stream) => {
                  if (execErr) {
                    conn.end();
                    return res.status(500).json({ error: execErr.message });
                  }
                  stream.write(server.password + "\n");
                  let output = "";
                  let error = "";
                  stream.on("data", (data) => (output += data.toString()));
                  stream.stderr.on("data", (data) => (error += data.toString()));
                  stream.on("close", (code) => {
                    conn.end();
                    res.json({ code, output, error });
                  });
                });
              });

              writeStream.on("error", (e: any) => {
                conn.end();
                fs.unlinkSync(localTmpPath);
                res.status(500).json({ error: e.message });
              });

              readStream.pipe(writeStream);
            });
          });
        });
      })
      .on("error", (err) => {
        fs.unlinkSync(localTmpPath);
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  // --- DevOps: Stop and Remove Container ---
  app.post("/api/servers/:id/stop-container", (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const { containerName } = req.body;
    if (!containerName || typeof containerName !== 'string') {
      return res.status(400).json({ error: "Missing or invalid containerName" });
    }

    const safeContainerName = containerName.toLowerCase()
      .split('')
      .filter(c => 'abcdefghijklmnopqrstuvwxyz0123456789-_'.includes(c))
      .join('');
    
    if (!safeContainerName || safeContainerName !== containerName.toLowerCase()) {
      return res.status(400).json({ error: "Invalid container name" });
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        const script = `sudo -S -p '' docker rm -f ${safeContainerName}`;
        conn.exec(script, (err, stream) => {
          if (err) {
            conn.end();
            return res.status(500).json({ error: err.message });
          }
          stream.write(server.password + "\n");
          let output = "";
          let error = "";
          stream.on("data", (data) => (output += data.toString()));
          stream.stderr.on("data", (data) => (error += data.toString()));
          stream.on("close", (code) => {
            conn.end();
            res.json({ code, output, error });
          });
        });
      })
      .on("error", (err) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  // --- Cluster: Deploy Sample App ---
  app.post("/api/clusters/:id/deploy-sample", async (req, res) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });
    const results = [];
    for (const serverId of cluster.serverIds) {
      const server = db.servers.find((s: any) => s.id === serverId);
      if (!server) {
        results.push({ serverId, error: "Server not found" });
        continue;
      }
      const conn = new Client();
      await new Promise((resolve) => {
        conn
          .on("ready", () => {
            // Fully hardcoded command — no user input
            conn.exec("docker run -d --name prod-nginx -p 8080:80 nginx", (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                return resolve(null);
              }
              let output = "";
              let error = "";
              stream.on("data", (data) => (output += data.toString()));
              stream.stderr.on("data", (data) => (error += data.toString()));
              stream.on("close", (code) => {
                results.push({ serverId, code, output, error });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect({
            host: server.host,
            port: server.port || 22,
            username: server.username,
            password: server.password,
          });
      });
    }
    res.json({ results });
  });

  // --- Cluster: Simulate Prod Load ---
  app.post("/api/clusters/:id/simulate-load", async (req, res) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });
    const results = [];
    for (const serverId of cluster.serverIds) {
      const server = db.servers.find((s: any) => s.id === serverId);
      if (!server) {
        results.push({ serverId, error: "Server not found" });
        continue;
      }
      const conn = new Client();
      await new Promise((resolve) => {
        conn
          .on("ready", () => {
            // Fully hardcoded — no user input
            const cmd = `nohup sh -c 'for i in $(seq 1 5); do wget -qO /dev/null http://speedtest.tele2.net/10MB.zip; done & dd if=/dev/zero of=/dev/null bs=1M count=2000 &' >/dev/null 2>&1 &`;
            conn.exec(cmd, (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                return resolve(null);
              }
              stream.on("close", (code) => {
                results.push({ serverId, code, output: "Load simulation started" });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect({
            host: server.host,
            port: server.port || 22,
            username: server.username,
            password: server.password,
          });
      });
    }
    res.json({ results });
  });

  // --- Basic Cluster CRUD ---
  app.get("/api/clusters", (req, res) => {
    const db = getDB();
    res.json(db.clusters || []);
  });
  app.get("/api/clusters/:id", (req, res) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });
    res.json(cluster);
  });
  app.post("/api/clusters", (req, res) => {
    const { name, serverIds } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const db = getDB();
    const newCluster = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      serverIds: serverIds || [],
    };
    db.clusters.push(newCluster);
    saveDB(db);
    res.json(newCluster);
  });
  app.put("/api/clusters/:id", (req, res) => {
    const db = getDB();
    const idx = db.clusters.findIndex((c: any) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Cluster not found" });
    db.clusters[idx] = { ...db.clusters[idx], ...req.body };
    saveDB(db);
    res.json(db.clusters[idx]);
  });
  app.delete("/api/clusters/:id", (req, res) => {
    const db = getDB();
    db.clusters = db.clusters.filter((c: any) => c.id !== req.params.id);
    saveDB(db);
    res.status(204).end();
  });

  app.get("/api/servers/:id/telemetry", async (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        // Fully hardcoded telemetry command — no user input interpolated
        const cmd = `
          echo "disk: $(df -h / | tail -1 | awk '{print $5}')"
          echo "disk_free: $(df -h / | tail -1 | awk '{print $4}')"
          echo "disk_total: $(df -h / | tail -1 | awk '{print $2}')"
          echo "cpu: $(sh -lc 'if [ -r /proc/stat ]; then read -r _ u n s i iw irq sir st g gn < /proc/stat; t1=$((u+n+s+i+iw+irq+sir+st)); idle1=$i; sleep 0.5; read -r _ u n s i iw irq sir st g gn < /proc/stat; t2=$((u+n+s+i+iw+irq+sir+st)); idle2=$i; dt=$((t2-t1)); didle=$((idle2-idle1)); if [ "$dt" -gt 0 ]; then awk "BEGIN { printf \\"%.1f\\", (1-($didle/$dt))*100 }"; else echo 0; fi; else echo 0; fi')"
          echo "ram: $(sh -lc 'if [ -r /proc/meminfo ]; then total=$(awk "/^MemTotal:/ {print \\$2}" /proc/meminfo); avail=$(awk "/^MemAvailable:/ {print \\$2}" /proc/meminfo); if [ -n "$total" ] && [ -n "$avail" ] && [ "$total" -gt 0 ]; then awk "BEGIN { printf \\"%.1f\\", (($total-$avail)/$total)*100 }"; else echo 0; fi; else echo 0; fi')"
          echo "ram_total_mb: $(sh -lc 'awk "/^MemTotal:/ { printf \\"%.0f\\", \\$2/1024 }" /proc/meminfo 2>/dev/null || echo 0')"
          echo "ram_available_mb: $(sh -lc 'awk "/^MemAvailable:/ { printf \\"%.0f\\", \\$2/1024 }" /proc/meminfo 2>/dev/null || echo 0')"
          echo "swap_used_mb: $(sh -lc 'if [ -r /proc/meminfo ]; then st=$(awk "/^SwapTotal:/ {print \\$2}" /proc/meminfo); sf=$(awk "/^SwapFree:/ {print \\$2}" /proc/meminfo); if [ -n "$st" ] && [ -n "$sf" ]; then awk "BEGIN { printf \\"%.0f\\", (($st-$sf)/1024) }"; else echo 0; fi; else echo 0; fi')"
          echo "load1: $(sh -lc 'awk "{print \\$1}" /proc/loadavg 2>/dev/null || echo 0')"
          echo "load5: $(sh -lc 'awk "{print \\$2}" /proc/loadavg 2>/dev/null || echo 0')"
          echo "load15: $(sh -lc 'awk "{print \\$3}" /proc/loadavg 2>/dev/null || echo 0')"
          echo "uptime_s: $(sh -lc 'awk "{printf \\"%.0f\\", \\$1}" /proc/uptime 2>/dev/null || echo 0')"
          echo "net_rx_mb: $(sh -lc 'awk -F\"[: ]+\" \"NR>2 {rx+=\\$3} END {printf \\"%.1f\\", rx/1024/1024}\" /proc/net/dev 2>/dev/null || echo 0')"
          echo "net_tx_mb: $(sh -lc 'awk -F\"[: ]+\" \"NR>2 {tx+=\\$11} END {printf \\"%.1f\\", tx/1024/1024}\" /proc/net/dev 2>/dev/null || echo 0')"
          echo "docker: $(docker --version 2>/dev/null || echo 'none')"
          echo "k3s: $(k3s --version 2>/dev/null || echo 'none')"
        `;

        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            return res.status(500).json({ error: err.message });
          }
          let output = "";
          stream.on("data", (data) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const stats: any = {};
            output.split("\n").forEach((line) => {
              const colonIdx = line.indexOf(": ");
              if (colonIdx !== -1) {
                const key = line.substring(0, colonIdx).trim();
                const val = line.substring(colonIdx + 2).trim();
                if (key) stats[key] = val;
              }
            });

            const freshDb = getDB();
            const srv = freshDb.servers.find((s: any) => s.id === req.params.id);
            if (srv) {
              srv.status = "online";
              srv.installed.docker = !!(stats.docker && stats.docker !== "none");
              srv.installed.k8s = !!(stats.k3s && stats.k3s !== "none");
              saveDB(freshDb);
            }

            res.json(stats);
          });
        });
      })
      .on("error", (err) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
      });
  });

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // WebSocket for SSH Terminal
  // FIX #7 (High): "Missing rate limiting" — track connections per IP and reject excess.
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ssh" });

  const wsConnectionCount = new Map<string, number>();
  const WS_MAX_CONNECTIONS_PER_IP = 10;
  const WS_RATE_WINDOW_MS = 60_000;
  const wsRateTracker = new Map<string, { count: number; resetAt: number }>();

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";

    // ── Per-IP connection cap ──────────────────────────────────────────────
    const currentConns = wsConnectionCount.get(ip) ?? 0;
    if (currentConns >= WS_MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    wsConnectionCount.set(ip, currentConns + 1);
    ws.on("close", () => {
      wsConnectionCount.set(ip, Math.max(0, (wsConnectionCount.get(ip) ?? 1) - 1));
    });

    // ── Per-IP message rate limit ──────────────────────────────────────────
    function checkMessageRate(): boolean {
      const now = Date.now();
      const tracker = wsRateTracker.get(ip);
      if (!tracker || now > tracker.resetAt) {
        wsRateTracker.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW_MS });
        return true;
      }
      tracker.count++;
      if (tracker.count > 200) return false; // max 200 messages per minute per IP
      return true;
    }

    let sshClient: Client | null = null;
    let connectedServerId: string | null = null;

    const provisionSnippets = {
      ensureCurl: [
        'if command -v curl >/dev/null 2>&1; then echo "  -> curl already installed";',
        'elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates;',
        'elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install curl ca-certificates;',
        'elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install curl ca-certificates;',
        'elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache curl ca-certificates;',
        'elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm curl ca-certificates;',
        'elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y curl ca-certificates;',
        'else echo "ERROR: unsupported OS (no known package manager to install curl)"; exit 1; fi',
      ].join(" "),
      ensureBasicTools: [
        "if command -v apt-get >/dev/null 2>&1; then",
        "  sudo apt-get update -qq;",
        "  sudo apt-get install -y -qq wget ca-certificates gnupg;",
        "  sudo apt-get install -y -qq lsb-release 2>/dev/null || true;",
        "  sudo apt-get install -y -qq apt-transport-https 2>/dev/null || true;",
        "  sudo apt-get install -y -qq software-properties-common 2>/dev/null || true;",
        "elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install wget ca-certificates gnupg2 redhat-lsb-core;",
        "elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install wget ca-certificates gnupg2 redhat-lsb-core;",
        "elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache wget ca-certificates gnupg;",
        "elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm wget ca-certificates gnupg;",
        "elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y wget ca-certificates gpg2;",
        'else echo "WARN: skipping noncritical prereqs (unknown package manager)"; fi',
      ].join(" "),
    } as const;

    ws.on("message", (message: string) => {
      // ── Rate limit check ────────────────────────────────────────────────
      if (!checkMessageRate()) {
        ws.send(JSON.stringify({ type: "error", data: "Rate limit exceeded. Slow down." }));
        return;
      }

      const data = JSON.parse(message.toString());

      if (data.type === "connect") {
        const db = getDB();
        const server = db.servers.find((s: any) => s.id === data.serverId);

        if (!server) {
          ws.send(JSON.stringify({ type: "error", data: "Server not found in database" }));
          return;
        }

        connectedServerId = server.id;
        sshClient = new Client();
        sshClient
          .on("ready", () => {
            const currentDb = getDB();
            const srv = currentDb.servers.find((s: any) => s.id === connectedServerId);
            if (srv) {
              srv.status = "online";
              saveDB(currentDb);
            }

            ws.send(JSON.stringify({ type: "status", data: "Connected" }));
            sshClient?.shell((err, stream) => {
              if (err) {
                ws.send(JSON.stringify({ type: "error", data: err.message }));
                return;
              }
              stream.on("data", (chunk: any) => {
                ws.send(JSON.stringify({ type: "data", data: chunk.toString() }));
              });
              stream.on("close", () => {
                ws.send(JSON.stringify({ type: "status", data: "Disconnected" }));
              });
              ws.on("message", (msg: string) => {
                const input = JSON.parse(msg.toString());
                if (input.type === "input") {
                  stream.write(input.data);
                }
              });
            });
          })
          .on("error", (err) => {
            ws.send(JSON.stringify({ type: "error", data: err.message }));
          })
          .connect({
            host: server.host,
            port: server.port || 22,
            username: server.username,
            password: server.password,
          });
      }

      if (data.type === "deploy") {
        if (!sshClient) {
          ws.send(
            JSON.stringify({ type: "error", data: "No active SSH connection. Open a terminal first." })
          );
          return;
        }

        const { scriptType } = data;

        // scriptType must be one of the known deploy types — no user-controlled data
        // flows into commands from here
        const ALLOWED_SCRIPT_TYPES = new Set(["docker", "k3s", "verify", "full"]);
        if (!ALLOWED_SCRIPT_TYPES.has(scriptType)) {
          ws.send(JSON.stringify({ type: "error", data: "Unknown script type." }));
          return;
        }

        let command = "";

        if (scriptType === "docker") {
          command = [
            "set -e",
            'echo "[1/3] Ensuring curl..."',
            provisionSnippets.ensureCurl,
            'echo "[2/3] Installing Docker (get.docker.com)..."',
            'if command -v docker > /dev/null 2>&1; then echo "  -> Docker already installed: $(docker --version)"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo "  -> Docker installed successfully"; fi',
            'echo "[3/3] Done."',
          ].join(" && ");
        } else if (scriptType === "k3s") {
          command = [
            "set -e",
            'echo "[1/2] Ensuring curl..."',
            provisionSnippets.ensureCurl,
            'echo "[2/2] Installing K3s..."',
            'if command -v k3s > /dev/null 2>&1; then echo "  -> K3s already installed: $(k3s --version 2>&1 | head -1)"; else curl -sfL https://get.k3s.io | sh - && echo "  -> K3s installed successfully"; fi',
          ].join(" && ");
        } else if (scriptType === "verify") {
          command = [
            "set -e",
            'echo "==========================================="',
            'echo "        KubeCast Stack Verification"',
            'echo "==========================================="',
            'echo ""',
            'echo "[1/4] Docker binary..."',
            'if command -v docker >/dev/null 2>&1; then echo "  -> $(docker --version)"; else echo "  -> MISSING"; fi',
            'echo ""',
            'echo "[2/4] Docker service..."',
            'if command -v systemctl >/dev/null 2>&1; then echo "  -> $(sudo systemctl is-active docker 2>/dev/null || echo not-running)"; else echo "  -> (no systemctl)"; fi',
            'echo ""',
            'echo "[3/4] K3s service..."',
            'if command -v systemctl >/dev/null 2>&1; then echo "  -> $(sudo systemctl is-active k3s 2>/dev/null || echo not-running)"; else echo "  -> (no systemctl)"; fi',
            'echo ""',
            'echo "[4/4] Kubernetes API..."',
            'if command -v k3s >/dev/null 2>&1; then sudo k3s kubectl get nodes -o wide || true; else echo "  -> k3s not installed"; fi',
            'echo ""',
            'echo "=== VERIFY COMPLETE ==="',
          ].join(" && ");
        } else if (scriptType === "full") {
          command = [
            'echo "=========================================="',
            'echo "   KubeCast Full Stack Deployment"',
            'echo "=========================================="',
            'echo ""',
            "set -e",
            'echo "[1/5] Ensuring curl..."',
            provisionSnippets.ensureCurl,
            'echo ""',
            'echo "[2/5] Installing prerequisites..."',
            provisionSnippets.ensureBasicTools,
            'echo ""',
            'echo "[3/5] Installing Docker..."',
            'if command -v docker > /dev/null 2>&1; then echo "  -> Docker already installed: $(docker --version)"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo "  -> Docker installed successfully"; fi',
            'echo ""',
            'echo "[4/5] Installing K3s (Lightweight Kubernetes)..."',
            'if command -v k3s > /dev/null 2>&1; then echo "  -> K3s already installed: $(k3s --version 2>&1 | head -1)"; else curl -sfL https://get.k3s.io | sh - && echo "  -> K3s installed successfully"; fi',
            'echo ""',
            'echo "[5/5] Verifying services..."',
            'echo "==========================================="',
            'echo "  Docker: $(sudo systemctl is-active docker 2>/dev/null || echo not-running)"',
            'echo "  K3s:    $(sudo systemctl is-active k3s 2>/dev/null || echo not-running)"',
            'echo "==========================================="',
            'echo ""',
            'echo "=== DEPLOYMENT COMPLETE ==="',
          ].join(" && ");
        }

        if (command) {
          const db = getDB();
          const connectedServer = connectedServerId
            ? db.servers.find((s: any) => s.id === connectedServerId)
            : null;
          const sudoPassword: string = connectedServer?.password || "";

          const requiresSudo = /\bsudo\b/.test(command);
          if (requiresSudo && !sudoPassword) {
            ws.send(
              JSON.stringify({
                type: "error",
                data: "This deploy requires sudo, but no password is stored for this server.",
              })
            );
            return;
          }

          const finalCommand = requiresSudo
            ? ["sudo -S -p '' -v", command].join(" && ")
            : command;

          sshClient.exec(finalCommand, { pty: true }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: "error", data: err.message }));
              return;
            }

            let sudoSent = false;
            const maybeSendSudo = () => {
              if (!requiresSudo || sudoSent) return;
              sudoSent = true;
              stream.write(sudoPassword + "\n");
            };

            maybeSendSudo();

            stream.on("data", (chunk: any) => {
              const text = chunk.toString();
              if (!sudoSent && /password/i.test(text)) maybeSendSudo();
              ws.send(JSON.stringify({ type: "data", data: text }));
            });
            stream.stderr.on("data", (chunk: any) => {
              const text = chunk.toString();
              if (!sudoSent && /password/i.test(text)) maybeSendSudo();
              ws.send(JSON.stringify({ type: "data", data: text }));
            });
            stream.on("close", (code: number) => {
              if (code === 0 && connectedServerId) {
                const db = getDB();
                const srv = db.servers.find((s: any) => s.id === connectedServerId);
                if (srv) {
                  if (scriptType === "docker" || scriptType === "full") srv.installed.docker = true;
                  if (scriptType === "k3s" || scriptType === "full") srv.installed.k8s = true;
                  saveDB(db);
                }
                ws.send(
                  JSON.stringify({ type: "status", data: `${scriptType} installed successfully` })
                );
              }
            });
          });
        }
      }
    });

    ws.on("close", () => {
      sshClient?.end();
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

startServer();
