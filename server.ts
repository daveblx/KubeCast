import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import fs from "fs";
import cors from "cors";

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

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

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

  app.get("/api/servers/:id/telemetry", async (req, res) => {
    const db = getDB();
    const server = db.servers.find((s: any) => s.id === req.params.id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    const conn = new Client();
    conn.on("ready", () => {
      // Run multiple commands to get real telemetry
      // 1. Disk usage 2. CPU usage 3. RAM usage 4. Load avg 5. Uptime
      // 6. RAM totals 7. Swap 8. Network rx/tx 9. Docker version 10. K3s version
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
        stream.on("data", (data) => output += data.toString());
        stream.on("close", () => {
          conn.end();
          // Parse the raw terminal output
          const stats: any = {};
          output.split("\n").forEach(line => {
            const [key, val] = line.split(": ");
            if (key && val) stats[key.trim()] = val.trim();
          });

          // Update server status and installed flags based on live telemetry
          const freshDb = getDB();
          const srv = freshDb.servers.find((s: any) => s.id === req.params.id);
          if (srv) {
            srv.status = "online";
            srv.installed.docker = !!(stats.docker && stats.docker !== 'none');
            srv.installed.k8s = !!(stats.k3s && stats.k3s !== 'none');
            saveDB(freshDb);
          }

          res.json(stats);
        });
      });
    }).on("error", (err) => {
      res.status(500).json({ error: "Connection failed: " + err.message });
    }).connect({
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
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ssh" });

  wss.on("connection", (ws) => {
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
        'if command -v apt-get >/dev/null 2>&1; then',
        '  sudo apt-get update -qq;',
        '  sudo apt-get install -y -qq wget ca-certificates gnupg;',
        '  sudo apt-get install -y -qq lsb-release 2>/dev/null || true;',
        '  sudo apt-get install -y -qq apt-transport-https 2>/dev/null || true;',
        '  sudo apt-get install -y -qq software-properties-common 2>/dev/null || true;',
        'elif command -v dnf >/dev/null 2>&1; then sudo dnf -y -q install wget ca-certificates gnupg2 redhat-lsb-core;',
        'elif command -v yum >/dev/null 2>&1; then sudo yum -y -q install wget ca-certificates gnupg2 redhat-lsb-core;',
        'elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache wget ca-certificates gnupg;',
        'elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm wget ca-certificates gnupg;',
        'elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install -y wget ca-certificates gpg2;',
        'else echo "WARN: skipping noncritical prereqs (unknown package manager)"; fi',
      ].join(" "),
    } as const;

    ws.on("message", (message: string) => {
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
            // Update server status to online
            const currentDb = getDB();
            const srv = currentDb.servers.find((s: any) => s.id === connectedServerId);
            if (srv) {
              srv.status = "online";
              saveDB(currentDb);
            }

            ws.send(JSON.stringify({ type: "status", data: "Connected" }));
            // Start a shell
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
              
              // Handle incoming input
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
          ws.send(JSON.stringify({ type: "error", data: "No active SSH connection. Open a terminal first." }));
          return;
        }

        const { scriptType } = data;
        let command = "";
        
        if (scriptType === "docker") {
          command = [
            'set -e',
            'echo "[1/3] Ensuring curl..."',
            provisionSnippets.ensureCurl,
            'echo "[2/3] Installing Docker (get.docker.com)..."',
            'if command -v docker > /dev/null 2>&1; then echo "  -> Docker already installed: $(docker --version)"; else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh && sudo usermod -aG docker $USER && rm -f /tmp/get-docker.sh && echo "  -> Docker installed successfully"; fi',
            'echo "[3/3] Done."',
          ].join(' && ');
        } else if (scriptType === "k3s") {
          command = [
            'set -e',
            'echo "[1/2] Ensuring curl..."',
            provisionSnippets.ensureCurl,
            'echo "[2/2] Installing K3s..."',
            'if command -v k3s > /dev/null 2>&1; then echo "  -> K3s already installed: $(k3s --version 2>&1 | head -1)"; else curl -sfL https://get.k3s.io | sh - && echo "  -> K3s installed successfully"; fi',
          ].join(' && ');
        } else if (scriptType === "verify") {
          command = [
            'set -e',
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
          ].join(' && ');
        } else if (scriptType === "full") {
          command = [
            'echo "=========================================="',
            'echo "   KubeCast Full Stack Deployment"',
            'echo "=========================================="',
            'echo ""',
            'set -e',
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
          ].join(' && ');
        }

        if (command) {
          // Use the stored SSH password to satisfy sudo prompts non-interactively.
          // We avoid embedding the password in the command string; instead we feed it via stdin to `sudo -S`.
          const db = getDB();
          const connectedServer = connectedServerId
            ? db.servers.find((s: any) => s.id === connectedServerId)
            : null;
          const sudoPassword: string = connectedServer?.password || "";

          const requiresSudo = /\bsudo\b/.test(command);
          if (requiresSudo && !sudoPassword) {
            ws.send(JSON.stringify({ type: "error", data: "This deploy requires sudo, but no password is stored for this server." }));
            return;
          }

          const finalCommand = requiresSudo
            ? [
                // Refresh sudo timestamp first, then run the original command.
                // -S: read password from stdin, -p '': no prompt noise.
                // In a PTY session some distros require a tty for sudo.
                "sudo -S -p '' -v",
                command,
              ].join(" && ")
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

            // Send immediately for sudo -v, and also retry once if we detect a prompt.
            maybeSendSudo();

            stream.on("data", (chunk: any) => {
              const text = chunk.toString();
              // Some sudo configurations still print a prompt (or require a second send).
              if (!sudoSent && /password/i.test(text)) {
                maybeSendSudo();
              }
              ws.send(JSON.stringify({ type: "data", data: text }));
            });
            stream.stderr.on("data", (chunk: any) => {
              const text = chunk.toString();
              if (!sudoSent && /password/i.test(text)) {
                maybeSendSudo();
              }
              ws.send(JSON.stringify({ type: "data", data: text }));
            });
            stream.on("close", (code: number) => {
              // Update installed status in db after deployment
              if (code === 0 && connectedServerId) {
                const db = getDB();
                const srv = db.servers.find((s: any) => s.id === connectedServerId);
                if (srv) {
                  if (scriptType === "docker" || scriptType === "full") srv.installed.docker = true;
                  if (scriptType === "k3s" || scriptType === "full") srv.installed.k8s = true;
                  saveDB(db);
                }
                ws.send(JSON.stringify({ type: "status", data: `${scriptType} installed successfully` }));
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
