import express, { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import fs from "fs";
// @ts-expect-error no type declarations available for cors
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import os from "os";
import { deployTemplate, TemplateConfig } from "./src/deploy/template";

const upload = multer({ dest: "/tmp" });

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});


const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");

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

// ─── Allowed commands allowlist for /exec ─────────────────────
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

// ─── Safe remote path validator ────────────────────────────────
function safePosixPath(userInput: string, username: string): string | null {
  if (!userInput || typeof userInput !== "string") return null;
  const normalized = path.posix.normalize(userInput);
  const allowed = [`/tmp/`, `/home/${username}/`];
  for (const prefix of allowed) {
    if (normalized.startsWith(prefix)) return normalized;
  }
  return null;
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function getServerSSHConfig(server: any) {
  const config: any = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
  };
  if (server.privateKey) {
    config.privateKey = server.privateKey;
  } else {
    config.password = server.password;
  }
  return config;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE"]
  }));
  app.use(express.json());
  app.use(limiter);

  // Server Management API
  app.get("/api/servers", (_req: Request, res: Response) => {
    const db = getDB();
    const sanitized = db.servers.map(({ password, privateKey, ...rest }: any) => rest);
    res.json(sanitized);
  });

  app.post("/api/servers", (req: Request, res: Response) => {
    const { name, host, username, port, password, privateKey } = req.body;

    if (!name || !host || !username) {
      res.status(400).json({ error: "name, host, and username are required" });
    }

    const db = getDB();
    const newServer = {
      id: crypto.randomUUID(),
      name,
      host,
      username,
      port: port || 22,
      password: password || "",
      privateKey: privateKey || "",
      status: "offline",
      installed: { docker: false, k8s: false },
    };
    db.servers.push(newServer);
    saveDB(db);
    const { password: _, privateKey: __, ...sanitized } = newServer;
    res.json(sanitized);
  });

  app.delete("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    db.servers = db.servers.filter((s: any) => s.id !== req.params.id);
    saveDB(db);
    res.status(204).end();
  });

  app.get("/api/template/config/defaults", (_req: Request, res: Response) => {
    const config: TemplateConfig = {
      domain: "",
      email: "",
      duckdnsToken: "",
      profiles: ["required"],
      authelia: {
        jwtSecret: crypto.randomBytes(32).toString("hex"),
        sessionSecret: crypto.randomBytes(32).toString("hex"),
        storageKey: crypto.randomBytes(32).toString("hex"),
      }
    };
    res.json(config);
  });

  app.get("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });
    const { password: _, privateKey: __, ...sanitized } = server;
    res.json(sanitized);
  });

  app.put("/api/servers/:id", (req: Request, res: Response) => {
    const db = getDB();
    const idx = db.servers.findIndex((s: any) => s.id === req.params.id);
    if (idx === -1) res.status(404).json({ error: "Server not found" });
    db.servers[idx] = { ...db.servers[idx], ...req.body };
    saveDB(db);
    const { password: _, privateKey: __, ...sanitized } = db.servers[idx];
    res.json(sanitized);
  });

  app.post("/api/servers/:id/upload", upload.single("file"), (req: any, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });
    if (!req.file) res.status(400).json({ error: "No file uploaded" });

    if (!req.file.path.startsWith("/tmp/")) {
      res.status(400).json({ error: "Invalid local file path" });
    }

    const safeOriginalName = path.basename(req.file.originalname);
    const rawRemotePath = req.body.remotePath || `/tmp/${safeOriginalName}`;
    const sanitizedRemotePath = safePosixPath(rawRemotePath, server.username);
    if (!sanitizedRemotePath) {
      const localPath = req.file.path.startsWith("/tmp/") ? path.join("/tmp", path.basename(req.file.path)) : null;
      if (localPath) fs.unlinkSync(localPath);
      res.status(400).json({
        error: "Remote path must be within /tmp/ or /home/<username>/",
      });
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }

          const safeLocalPath = path.join("/tmp", path.basename(req.file.path));
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
          return;
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/destroy", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        // Use interactive bash shell to handle sudo properly
        conn.exec("sudo -S -p 'SUDO_PROMPT:' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }

          // Send password first
          stream.write(server.password + "\n");

          // Then send the cleanup commands
          const destroyCmd = [
            'echo "Initiating nuclear cleanup..."',
            "/usr/local/bin/k3s-uninstall.sh 2>/dev/null || true",
            "/usr/local/bin/k3s-agent-uninstall.sh 2>/dev/null || true",
            "docker stop $(docker ps -aq) 2>/dev/null || true",
            "docker rm $(docker ps -aq) 2>/dev/null || true",
            "docker system prune -af --volumes 2>/dev/null || true",
            "apt-get purge -y docker-engine docker docker.io docker-ce docker-ce-cli containerd containerd.io 2>/dev/null || yum remove -y docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine 2>/dev/null || true",
            "rm -rf /var/lib/docker /etc/docker /var/lib/containerd /var/run/docker.sock /var/lib/rancher /etc/rancher ~/.kube 2>/dev/null || true",
            'echo "Cleanup complete. System is clean."',
            "exit"
          ].join("\n");

          stream.write(destroyCmd + "\n");
          stream.end();

          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
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
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/exec", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const { command } = req.body;
    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "Missing or invalid command" });
    }

    let safeCommand = "";
    for (const allowedCmd of ALLOWED_EXEC_COMMANDS) {
      if (allowedCmd === command.trim()) {
        safeCommand = allowedCmd;
        break;
      }
    }

    if (!safeCommand) {
      res.status(403).json({
        error: "Command not permitted. Use one of the allowed commands.",
        allowed: [...ALLOWED_EXEC_COMMANDS],
      });
    }

    const conn = new Client();
    let output = "";
    let errorStr = "";
    conn
      .on("ready", () => {
        conn.exec("/bin/sh -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          stream.write(safeCommand + "\n");
          stream.end();

          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ code, output, error: errorStr });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/deploy-dockerfile", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const { dockerfile, containerName, portMapping } = req.body;
    if (!dockerfile || !containerName) {
      res.status(400).json({ error: "Missing parameters" });
    }

    if (typeof containerName !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name. Only lowercase alphanumeric, hyphens, and underscores allowed." });
    }
    const safeContainerName = containerName;

    let safePortFlag = "";
    if (portMapping) {
      if (typeof portMapping !== 'string' || !/^\d{1,5}:\d{1,5}$/.test(portMapping.trim())) {
        res.status(400).json({ error: "Invalid port mapping format. Use HOST:CONTAINER (e.g. 8080:80)" });
      }
      safePortFlag = `-p ${portMapping.trim()}`;
    }

    const localTmpPath = path.join(os.tmpdir(), `kubecast-dockerfile-${Date.now()}`);
    try {
      fs.writeFileSync(localTmpPath, dockerfile);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to write temp Dockerfile: " + e.message });
    }

    const workDir = `/tmp/kubecast-deploy-${safeContainerName}-${Date.now()}`;
    const conn = new Client();
    conn
      .on("ready", () => {
        const remoteDockerfile = `${workDir}/Dockerfile`;
        const setupCmd = `mkdir -p ${shellEscape(workDir)} && cat > ${shellEscape(remoteDockerfile)}`;
        
        conn.exec(setupCmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }

          stream.write(dockerfile);
          stream.end();

          stream.on("close", (code: number) => {
            if (code !== 0) {
              conn.end();
              if (fs.existsSync(localTmpPath)) fs.unlinkSync(localTmpPath);
              res.status(500).json({ error: `Setup failed with code ${code}` });
            }

            const buildAndRun = [
              `docker build -t ${shellEscape(safeContainerName)} ${shellEscape(workDir)}`,
              `docker rm -f ${shellEscape(safeContainerName)} 2>/dev/null || true`,
              `docker run -d --name ${shellEscape(safeContainerName)} ${safePortFlag} ${shellEscape(safeContainerName)}`,
              `rm -rf ${shellEscape(workDir)}`
            ].join(" && ");

            conn.exec("sudo -S -p '' bash -s", (execErr, execStream) => {
              if (execErr) {
                conn.end();
                if (fs.existsSync(localTmpPath)) fs.unlinkSync(localTmpPath);
                res.status(500).json({ error: execErr.message });
              }
              execStream.write(server.password + "\n");
              execStream.write(buildAndRun + "\n");
              execStream.end();

              let output = "";
              let errorStr = "";
              execStream.on("data", (data: Buffer) => {
                output += data.toString();
              });
              execStream.stderr.on("data", (data: Buffer) => {
                errorStr += data.toString();
              });
              execStream.on("close", (exitCode: number) => {
                conn.end();
                if (fs.existsSync(localTmpPath)) fs.unlinkSync(localTmpPath);
                res.json({ code: exitCode, output, error: errorStr });
              });
            });
          });
        });
      })
      .on("error", (err: any) => {
        if (fs.existsSync(localTmpPath)) fs.unlinkSync(localTmpPath);
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/servers/:id/stop-container", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const { containerName } = req.body;
    if (typeof containerName !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name" });
    }
    const safeContainerName = containerName;

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("sudo -S -p '' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          stream.write(server.password + "\n");
          stream.write(`docker rm -f ${safeContainerName}\n`);
          stream.end();

          let output = "";
          let errorStr = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ code, output, error: errorStr });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });
  
  app.get("/api/servers/:id/stats", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        const statsCmd = `top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" && free | grep Mem | awk '{print $3/$2 * 100.0}' && df -h / | awk 'NR==2{print $5}'`;
        conn.exec(statsCmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const lines = output.trim().split("\n");
            const cpuIdle = parseFloat(lines[0] || "100");
            const memUsage = parseFloat(lines[1] || "0");
            const diskUsage = (lines[2] || "0%").replace("%", "");
            
            res.json({
              cpu: (100 - cpuIdle).toFixed(1),
              memory: memUsage.toFixed(1),
              disk: diskUsage,
            });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Stats failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.get("/api/servers/:id/containers", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        // Try docker ps without sudo first, fall back to sudo if needed
        const cmd = "docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}' 2>/dev/null || sudo docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}' 2>/dev/null || echo ''";
        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const containers = output.trim().split("\n").filter(Boolean).map(line => {
              const parts = line.split("|");
              if (parts.length === 5) {
                const [name, image, status, ports, id] = parts;
                return { name, image, status, ports, id };
              }
              return null;
            }).filter(Boolean);
            res.json(containers);
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.delete("/api/servers/:id/containers/:name", (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const containerName = req.params.name;
    if (!/^[a-z0-9_-]{1,64}$/.test(containerName)) {
      res.status(400).json({ error: "Invalid container name" });
    }

    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("sudo -S -p '' bash -s", (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          stream.write(server.password + "\n");
          stream.write(`docker rm -f ${containerName}\n`);
          stream.end();

          let output = "";
          let errorStr = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
          stream.on("close", (code: number) => {
            conn.end();
            res.json({ code, output, error: errorStr });
          });
        });
      })
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  app.post("/api/clusters/:id/deploy-sample", async (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) res.status(404).json({ error: "Cluster not found" });
    const results: any[] = [];
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
            conn.exec("docker run -d --name prod-nginx -p 8080:80 nginx", (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                resolve(null);
              }
              let output = "";
              let errorStr = "";
              stream.on("data", (data: Buffer) => (output += data.toString()));
              stream.stderr.on("data", (data: Buffer) => (errorStr += data.toString()));
              stream.on("close", (code: number) => {
                results.push({ serverId, code, output, error: errorStr });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err: any) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect(getServerSSHConfig(server));
      });
    }
    res.json({ results });
  });

  app.post("/api/clusters/:id/simulate-load", async (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) res.status(404).json({ error: "Cluster not found" });
    const results: any[] = [];
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
            const cmd = `nohup sh -c 'for i in $(seq 1 5); do wget -qO /dev/null http://speedtest.tele2.net/10MB.zip; done & dd if=/dev/zero of=/dev/null bs=1M count=2000 &' >/dev/null 2>&1 &`;
            conn.exec(cmd, (err, stream) => {
              if (err) {
                results.push({ serverId, error: err.message });
                conn.end();
                resolve(null);
              }
              stream.on("close", (code: number) => {
                results.push({ serverId, code, output: "Load simulation started" });
                conn.end();
                resolve(null);
              });
            });
          })
          .on("error", (err: any) => {
            results.push({ serverId, error: "Connection failed: " + err.message });
            resolve(null);
          })
          .connect(getServerSSHConfig(server));
      });
    }
    res.json({ results });
  });

  app.get("/api/clusters", (_req: Request, res: Response) => {
    const db = getDB();
    res.json(db.clusters || []);
  });
  app.get("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    const cluster = db.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) res.status(404).json({ error: "Cluster not found" });
    res.json(cluster);
  });
  app.post("/api/clusters", (req: Request, res: Response) => {
    const { name, serverIds } = req.body;
    if (!name) res.status(400).json({ error: "name is required" });
    const db = getDB();
    const newCluster = {
      id: crypto.randomUUID(),
      name,
      serverIds: serverIds || [],
    };
    db.clusters.push(newCluster);
    saveDB(db);
    res.json(newCluster);
  });
  app.put("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    const idx = db.clusters.findIndex((c: any) => c.id === req.params.id);
    if (idx === -1) res.status(404).json({ error: "Cluster not found" });
    db.clusters[idx] = { ...db.clusters[idx], ...req.body };
    saveDB(db);
    res.json(db.clusters[idx]);
  });
  app.delete("/api/clusters/:id", (req: Request, res: Response) => {
    const db = getDB();
    db.clusters = db.clusters.filter((c: any) => c.id !== req.params.id);
    saveDB(db);
    res.status(204).end();
  });

  app.get("/api/servers/:id/telemetry", async (req: Request, res: Response) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    if (!server) res.status(404).json({ error: "Server not found" });

    const conn = new Client();
    conn
      .on("ready", () => {
        const cmd = `
          echo "disk: $(df -h / | tail -1 | awk '{print $5}')"
          echo "disk_free: $(df -h / | tail -1 | awk '{print $4}')"
          echo "disk_total: $(df -h / | tail -1 | awk '{print $2}')"
          echo "disk_usage_all: $(df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs | tail -n +2 | tr '\n' ';')"
          echo "cpu: $(sh -lc 'if [ -r /proc/stat ]; then read -r _ u n s i iw irq sir st g gn < /proc/stat; t1=$((u+n+s+i+iw+irq+sir+st)); idle1=$i; sleep 0.5; read -r _ u n s i iw irq sir st g gn < /proc/stat; t2=$((u+n+s+i+iw+irq+sir+st)); idle2=$i; dt=$((t2-t1)); didle=$((idle2-idle1)); if [ \"$dt\" -gt 0 ]; then awk \"BEGIN { printf \\\"%.1f\\\", (1-($didle/$dt))*100 }\"; else echo 0; fi; else echo 0; fi')"
          echo "ram: $(sh -lc 'if [ -r /proc/meminfo ]; then total=$(awk \"/^MemTotal:/ {print \\$2}\" /proc/meminfo); avail=$(awk \"/^MemAvailable:/ {print \\$2}\" /proc/meminfo); if [ -n \"$total\" ] && [ -n \"$avail\" ] && [ \"$total\" -gt 0 ]; then awk \"BEGIN { printf \\\"%.1f\\\", (($total-$avail)/$total)*100 }\"; else echo 0; fi; else echo 0; fi')"
          echo "ram_total_mb: $(sh -lc 'awk \"/^MemTotal:/ { printf \\\"%.0f\\\", \\$2/1024 }\" /proc/meminfo 2>/dev/null || echo 0')"
          echo "ram_available_mb: $(sh -lc 'awk \"/^MemAvailable:/ { printf \\$2/1024 }\" /proc/meminfo 2>/dev/null || echo 0')"
          echo "swap_used_mb: $(sh -lc 'if [ -r /proc/meminfo ]; then st=$(awk \"/^SwapTotal:/ {print \\$2}\" /proc/meminfo); sf=$(awk \"/^SwapFree:/ {print \\$2}\" /proc/meminfo); if [ -n \"$st\" ] && [ -n \"$sf\" ]; then awk \"BEGIN { printf \\\"%.0f\\\", (($st-$sf)/1024) }\"; else echo 0; fi; else echo 0; fi')"
          echo "load1: $(sh -lc 'awk \"{print \\$1}\" /proc/loadavg 2>/dev/null || echo 0')"
          echo "load5: $(sh -lc 'awk \"{print \\$2}\" /proc/loadavg 2>/dev/null || echo 0')"
          echo "load15: $(sh -lc 'awk \"{print \\$3}\" /proc/loadavg 2>/dev/null || echo 0')"
          echo "uptime_s: $(sh -lc 'awk \"{printf \\\"%.0f\\\", \\$1}\" /proc/uptime 2>/dev/null || echo 0')"
          echo "net_rx_mb: $(sh -lc 'awk -F\"[: ]+\" \"NR>2 {rx+=\\$3} END {printf \\\"%.1f\\\", rx/1024/1024}\" /proc/net/dev 2>/dev/null || echo 0')"
          echo "net_tx_mb: $(sh -lc 'awk -F\"[: ]+\" \"NR>2 {tx+=\\$11} END {printf \\\"%.1f\\\", tx/1024/1024}\" /proc/net/dev 2>/dev/null || echo 0')"
          echo "docker: $(docker --version 2>/dev/null || echo 'none')"
          echo "k3s: $(k3s --version 2>/dev/null || echo 'none')"
        `;

        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            res.status(500).json({ error: err.message });
          }
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
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
      .on("error", (err: any) => {
        res.status(500).json({ error: "Connection failed: " + err.message });
      })
      .connect(getServerSSHConfig(server));
  });

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ssh" });

  const wsConnectionCount = new Map<string, number>();
  const WS_MAX_CONNECTIONS_PER_IP = 10;
  const WS_RATE_WINDOW_MS = 60_000;
  const wsRateTracker = new Map<string, { count: number; resetAt: number }>();

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin;
    if (origin && process.env.NODE_ENV === "production") {
      const host = req.headers.host;
      if (origin !== `http://${host}` && origin !== `https://${host}`) {
        ws.close(1008, "Origin not allowed");
        return;
      }
    }
    const ip = req.socket.remoteAddress ?? "unknown";

    const currentConns = wsConnectionCount.get(ip) ?? 0;
    if (currentConns >= WS_MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    wsConnectionCount.set(ip, currentConns + 1);
    ws.on("close", () => {
      wsConnectionCount.set(ip, Math.max(0, (wsConnectionCount.get(ip) ?? 1) - 1));
    });

    function checkMessageRate(): boolean {
      const now = Date.now();
      const tracker = wsRateTracker.get(ip);
      if (!tracker || now > tracker.resetAt) {
        wsRateTracker.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW_MS });
        return true;
      }
      tracker.count++;
      if (tracker.count > 200) return false;
      return true;
    }

    let sshClient: Client | null = null;
    let connectedServerId: string | null = null;

    const provisionSnippets = {
      ensureCurl: [
        'if command -v curl >/dev/null 2>&1; then echo \"  -> curl already installed\";',
        'elif command -v apt-get >/dev/null 2>&1; then while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/dpkg/lock >/dev/null 2>&1; do sleep 2; done; sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates;',
        'elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install curl ca-certificates;',
        'elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install curl ca-certificates;',
        'elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache curl ca-certificates;',
        'elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm curl ca-certificates;',
        'elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y curl ca-certificates;',
        'else echo \"ERROR: unsupported OS (no known package manager to install curl)\"; exit 1; fi',
      ].join(" "),
      ensureBasicTools: [
        "if command -v apt-get >/dev/null 2>&1; then",
        "  echo 'Waiting for apt lock to clear...';",
        "  while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/dpkg/lock >/dev/null 2>&1 || sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do sleep 2; done;",
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
        'else echo \"WARN: skipping noncritical prereqs (unknown package manager)\"; fi',
      ].join(" "),
    } as const;

    ws.on("message", async (message: string) => {
      if (!checkMessageRate()) {
        ws.send(JSON.stringify({ type: "error", data: "Rate limit exceeded. Slow down." }));
        return;
      }

      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        return;
      }

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
              stream.on("data", (chunk: Buffer) => {
                ws.send(JSON.stringify({ type: "data", data: chunk.toString() }));
              });
              stream.on("close", () => {
                ws.send(JSON.stringify({ type: "status", data: "Disconnected" }));
              });
              ws.on("message", (msg: string) => {
                let input;
                try {
                   input = JSON.parse(msg.toString());
                } catch (e) {
                   return;
                }
                if (input.type === "input") {
                  stream.write(input.data);
                }
              });
            });
          })
          .on("error", (err: any) => {
            ws.send(JSON.stringify({ type: "error", data: err.message }));
          })
          .connect(getServerSSHConfig(server));
      }

      if (data.type === "deploy") {
        if (!sshClient) {
          ws.send(JSON.stringify({ type: "error", data: "No active SSH connection. Open a terminal first." }));
          return;
        }

        const { scriptType } = data;
        const ALLOWED_SCRIPT_TYPES = new Set(["docker", "k3s", "verify", "full", "template"]);
        if (!ALLOWED_SCRIPT_TYPES.has(scriptType)) {
          ws.send(JSON.stringify({ type: "error", data: "Unknown script type." }));
          return;
        }

        if (scriptType === "template") {
          const db = getDB();
          const server = db.servers.find((s: any) => s.id === connectedServerId);
          if (!server) {
            ws.send(JSON.stringify({ type: "error", data: "Server context lost." }));
            return;
          }

          await deployTemplate({
            sshClient,
            ws,
            sudoPassword: server.password,
            config: data.templateConfig as TemplateConfig
          });
          return;
        }

        let command = "";
        if (scriptType === "docker") {
          command = [
            "set -e",
            'echo \"[1/3] Ensuring curl...\"',
            provisionSnippets.ensureCurl,
            'echo \"[2/3] Installing Docker (get.docker.com)...\"',
            'if command -v docker > /dev/null 2>&1; then echo \"  -> Docker already installed: $(docker --version)\"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo \"  -> Docker installed successfully\"; fi',
            'echo \"[3/3] Done.\"',
          ].join(" && ");
        } else if (scriptType === "k3s") {
          command = [
            "set -e",
            'echo \"[1/2] Ensuring curl...\"',
            provisionSnippets.ensureCurl,
            'echo \"[2/2] Installing K3s...\"',
            'if command -v k3s > /dev/null 2>&1; then echo \"  -> K3s already installed: $(k3s --version 2>&1 | head -1)\"; else curl -sfL https://get.k3s.io | sh - && echo \"  -> K3s installed successfully\"; fi',
          ].join(" && ");
        } else if (scriptType === "verify") {
          command = [
            "set -e",
            'echo \"===========================================\"',
            'echo \"        KubeCast Stack Verification\"',
            'echo \"===========================================\"',
            'echo \"\"',
            'echo \"[1/4] Docker binary...\"',
            'if command -v docker >/dev/null 2>&1; then echo \"  -> $(docker --version)\"; else echo \"  -> MISSING\"; fi',
            'echo \"\"',
            'echo \"[2/4] Docker service...\"',
            'if command -v systemctl >/dev/null 2>&1; then echo \"  -> $(sudo systemctl is-active docker 2>/dev/null || echo not-running)\"; else echo \"  -> (no systemctl)\"; fi',
            'echo \"\"',
            'echo \"[3/4] K3s service...\"',
            'if command -v systemctl >/dev/null 2>&1; then echo \"  -> $(sudo systemctl is-active k3s 2>/dev/null || echo not-running)\"; else echo \"  -> (no systemctl)\"; fi',
            'echo \"\"',
            'echo \"[4/4] Kubernetes API...\"',
            'if command -v k3s >/dev/null 2>&1; then sudo k3s kubectl get nodes -o wide || true; else echo \"  -> k3s not installed\"; fi',
            'echo \"\"',
            'echo \"=== VERIFY COMPLETE ===\"',
          ].join(" && ");
        } else if (scriptType === "full") {
          command = [
            'echo \"==========================================\"',
            'echo \"   KubeCast Full Stack Deployment\"',
            'echo \"==========================================\"',
            'echo \"\"',
            "set -e",
            'echo \"[1/5] Ensuring curl...\"',
            provisionSnippets.ensureCurl,
            'echo \"\"',
            'echo \"[2/5] Installing prerequisites...\"',
            provisionSnippets.ensureBasicTools,
            'echo \"\"',
            'echo \"[3/5] Installing Docker...\"',
            'if command -v docker > /dev/null 2>&1; then echo \"  -> Docker already installed: $(docker --version)\"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo \"  -> Docker installed successfully\"; fi',
            'echo \"\"',
            'echo \"[4/5] Installing K3s (Lightweight Kubernetes)...\"',
            'if command -v k3s > /dev/null 2>&1; then echo \"  -> K3s already installed: $(k3s --version 2>&1 | head -1)\"; else curl -sfL https://get.k3s.io | sh - && echo \"  -> K3s installed successfully\"; fi',
            'echo \"\"',
            'echo \"[5/5] Verifying services...\"',
            'echo \"===========================================\"',
            'echo \"  Docker: $(sudo systemctl is-active docker 2>/dev/null || echo not-running)\"',
            'echo \"  K3s:    $(sudo systemctl is-active k3s 2>/dev/null || echo not-running)\"',
            'echo \"===========================================\"',
            'echo \"\"',
            'echo \"=== DEPLOYMENT COMPLETE ===\"',
          ].join(" && ");
        }

        if (command) {
          const db = getDB();
          const connectedServer = connectedServerId ? db.servers.find((s: any) => s.id === connectedServerId) : null;
          const sudoPassword: string = connectedServer?.password || "";
          const requiresSudo = /\bsudo\b/.test(command);
          
          if (requiresSudo && !sudoPassword) {
            ws.send(JSON.stringify({ type: "error", data: "This deploy requires sudo, but no password is stored for this server." }));
            return;
          }

          const finalCommand = requiresSudo ? ["sudo -S -p '' -v", command].join(" && ") : command;

          try {
            if (!sshClient || (sshClient as any)._state === 'closed' || (sshClient as any)._state === 'unconnected') {
              throw new Error("SSH connection lost or not established.");
            }

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

              stream.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                if (!sudoSent && /password/i.test(text)) maybeSendSudo();
                ws.send(JSON.stringify({ type: "data", data: text }));
              });
              stream.stderr.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                if (!sudoSent && /password/i.test(text)) maybeSendSudo();
                ws.send(JSON.stringify({ type: "data", data: text }));
              });
              stream.on("close", (code: number) => {
                if (code === 0 && connectedServerId) {
                  const dbLatest = getDB();
                  const srv = dbLatest.servers.find((s: any) => s.id === connectedServerId);
                  if (srv) {
                    if (scriptType === "docker" || scriptType === "full") srv.installed.docker = true;
                    if (scriptType === "k3s" || scriptType === "full") srv.installed.k8s = true;
                    saveDB(dbLatest);
                  }
                  ws.send(JSON.stringify({ type: "status", data: `${scriptType} installed successfully` }));
                }
              });
            });
          } catch (execErr: any) {
            ws.send(JSON.stringify({ type: "error", data: `SSH Execution failed: ${execErr.message}` }));
          }
        }
      }
    });

    ws.on("close", () => {
      sshClient?.end();
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.DIST_PATH || path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

startServer().catch(err => {
    console.error("Failed to start server:", err);
});