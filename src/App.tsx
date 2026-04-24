/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Server as ServerIcon, 
  Plus, 
  Terminal as TerminalIcon, 
  Shield, 
  Activity, 
  Settings,
  Database,
  Globe,
  Trash2,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Server } from './types';

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [activeTerminal, setActiveTerminal] = useState<Server | null>(null);
  const [autoDeployOnConnect, setAutoDeployOnConnect] = useState<null | 'full'>(null);
  const [autoRunOnConnect, setAutoRunOnConnect] = useState<
    null | { kind: 'input'; label: string; command: string } | { kind: 'deploy'; label: string; scriptType: 'verify' }
  >(null);
  const [isQuickDeployOpen, setIsQuickDeployOpen] = useState(false);
  const [quickDeployServerId, setQuickDeployServerId] = useState<string>('');
  const [telemetryByServerId, setTelemetryByServerId] = useState<Record<string, { cpu?: string; ram?: string; disk?: string }>>({});
  const [telemetryHistoryByServerId, setTelemetryHistoryByServerId] = useState<
    Record<string, Array<{ ts: number; cpu?: number; ram?: number; load1?: number; rxMb?: number; txMb?: number }>>
  >({});
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [isKeysModalOpen, setIsKeysModalOpen] = useState(false);
  const [isTrafficModalOpen, setIsTrafficModalOpen] = useState(false);
  const [serverSettings, setServerSettings] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentView, setCurrentView] = useState<'fleet' | 'terminals' | 'clusters' | 'storage' | 'settings'>('fleet');

  useEffect(() => {
    fetchServers();
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { serverId?: string } | undefined;
      const serverId = detail?.serverId;
      const srv = serverId ? servers.find(s => s.id === serverId) : null;
      if (!srv) return;
      setAutoRunOnConnect({
        kind: 'input',
        label: 'Analyze Log Bloat',
        command: 'sudo sh -lc \'du -h -d2 /var/log 2>/dev/null | sort -h | tail -n 30\'',
      });
      setActiveTerminal(srv);
    };
    window.addEventListener('kubecast:analyze-logs', handler as EventListener);
    return () => window.removeEventListener('kubecast:analyze-logs', handler as EventListener);
  }, [servers]);

  useEffect(() => {
    if (servers.length === 0) return;

    let cancelled = false;
    const fetchAll = async () => {
      try {
        const results = await Promise.all(
          servers.map(async (s) => {
            const res = await fetch(`/api/servers/${s.id}/telemetry`);
            const data = await res.json();
            if (data?.error) return [s.id, {}] as const;
            return [s.id, data] as const;
          })
        );

        if (cancelled) return;
        const next: Record<string, { cpu?: string; ram?: string; disk?: string }> = {};
        const historyUpdates: Array<{ id: string; cpu?: number; ram?: number; load1?: number; rxMb?: number; txMb?: number }> = [];
        for (const [id, data] of results) {
          next[id] = {
            cpu: data?.cpu,
            ram: data?.ram,
            disk: data?.disk,
          };
          historyUpdates.push({
            id,
            cpu: data?.cpu ? parseFloat(data.cpu) : undefined,
            ram: data?.ram ? parseFloat(data.ram) : undefined,
            load1: data?.load1 ? parseFloat(data.load1) : undefined,
            rxMb: data?.net_rx_mb ? parseFloat(data.net_rx_mb) : undefined,
            txMb: data?.net_tx_mb ? parseFloat(data.net_tx_mb) : undefined,
          });
        }
        setTelemetryByServerId(next);
        setTelemetryHistoryByServerId(prev => {
          const now = Date.now();
          const out: typeof prev = { ...prev };
          for (const u of historyUpdates) {
            const existing = out[u.id] ? [...out[u.id]] : [];
            existing.push({ ts: now, cpu: u.cpu, ram: u.ram, load1: u.load1, rxMb: u.rxMb, txMb: u.txMb });
            out[u.id] = existing.slice(-120); // ~1h at 30s interval
          }
          return out;
        });
      } catch {
        // best-effort background refresh
      }
    };

    fetchAll();
    const interval = window.setInterval(fetchAll, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [servers]);

  const fetchServers = async () => {
    try {
      const res = await fetch('/api/servers');
      const data = await res.json();
      setServers(data);
    } catch (error) {
      console.error('Failed to fetch servers', error);
    } finally {
      setLoading(false);
    }
  };

  const addServer = async (serverData: Partial<Server>) => {
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverData),
      });
      const newServer = await res.json();
      setServers([...servers, newServer]);
      setIsAddModalOpen(false);
    } catch (error) {
      console.error('Failed to add server', error);
    }
  };

  const deleteServer = async (id: string) => {
    if (!confirm('Are you sure you want to remove this server?')) return;
    try {
      await fetch(`/api/servers/${id}`, { method: 'DELETE' });
      setServers(servers.filter(s => s.id !== id));
    } catch (error) {
      console.error('Failed to delete server', error);
    }
  };

  const renderView = () => {
    switch (currentView) {
      case 'fleet':
        const loadSamples = Object.values(telemetryByServerId)
          .map(t => {
            const cpu = t.cpu ? parseFloat(t.cpu) : NaN;
            const ram = t.ram ? parseFloat(t.ram) : NaN;
            if (!Number.isFinite(cpu) && !Number.isFinite(ram)) return NaN;
            if (Number.isFinite(cpu) && Number.isFinite(ram)) return (cpu + ram) / 2;
            return Number.isFinite(cpu) ? cpu : ram;
          })
          .filter(v => Number.isFinite(v)) as number[];
        const avgLoad = loadSamples.length ? (loadSamples.reduce((a, b) => a + b, 0) / loadSamples.length) : null;
        const sortedServers = [...servers].sort((a, b) => {
          const aOnline = a.status === 'online' ? 1 : 0;
          const bOnline = b.status === 'online' ? 1 : 0;
          if (aOnline !== bOnline) return bOnline - aOnline;
          return a.name.localeCompare(b.name);
        });

        return (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="grid grid-cols-4 gap-6">
              <StatCard 
                label="Active Nodes" 
                value={servers.length.toString()} 
                trend={servers.length > 0 ? "System healthy" : "Fleet offline"} 
                trendColor={servers.length > 0 ? "text-green-600" : "text-gray-400"} 
              />
              <StatCard 
                label="Docker Hosts" 
                value={servers.filter(s => s.installed.docker).length.toString()} 
                trend={servers.length > 0 ? "Runtime active" : "No runtimes"} 
                trendColor="text-gray-400" 
              />
              <StatCard 
                label="K8s Nodes" 
                value={servers.filter(s => s.installed.k8s).length.toString()} 
                percentage={servers.length > 0 ? (servers.filter(s => s.installed.k8s).length / servers.length) * 100 : 0} 
              />
              <StatCard 
                label="Resource Load" 
                value={servers.length === 0 ? "0%" : (avgLoad == null ? "—" : `${avgLoad.toFixed(1)}%`)} 
                percentage={avgLoad == null ? 0 : Math.max(0, Math.min(100, avgLoad))} 
                variant="orange" 
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {loading ? (
                <div className="col-span-full flex items-center justify-center h-64">
                  <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                </div>
              ) : servers.length === 0 ? (
                <div className="col-span-full border-2 border-dashed border-gray-200 rounded-2xl p-16 text-center bg-white/50">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4 text-gray-400">
                    <ServerIcon className="w-6 h-6" />
                  </div>
                  <h3 className="text-gray-900 font-semibold mb-1">Fleet Empty</h3>
                  <p className="text-sm text-gray-500 mb-6">Start by connecting your first host via SSH.</p>
                  <button 
                    onClick={() => setIsAddModalOpen(true)}
                    className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 transition-all"
                  >
                    Connect Initial Host
                  </button>
                </div>
              ) : (
                sortedServers.map((server) => (
                  <ServerCard 
                    key={server.id} 
                    server={server} 
                    onDelete={deleteServer}
                    onTerminal={() => setActiveTerminal(server)}
                    onSettings={() => setServerSettings(server)}
                    history={telemetryHistoryByServerId[server.id] || []}
                  />
                ))
              )}
            </div>
          </div>
        );
      case 'terminals':
        return (
          <div className="space-y-6 animate-in fade-in duration-500">
            <h3 className="text-2xl font-bold tracking-tight">Active Sessions</h3>
            <div className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
              <table className="w-full text-left">
                <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                  <tr>
                    <th className="px-6 py-4">Node</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Log Path</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-xs">
                  {servers.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-gray-400 font-medium">No active SSH sessions</td>
                    </tr>
                  ) : (
                    servers.map(s => (
                      <tr key={s.id} className="hover:bg-gray-50/50">
                        <td className="px-6 py-4 font-bold text-gray-700">{s.name}</td>
                        <td className="px-6 py-4 text-gray-500 flex items-center gap-2">
                           <div className="w-1.5 h-1.5 rounded-full bg-gray-300" /> Ready
                        </td>
                        <td className="px-6 py-4 font-mono text-gray-400">/var/log/ssh/{s.id}.log</td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => setActiveTerminal(s)}
                            className="bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg font-bold hover:bg-blue-600 hover:text-white transition-all"
                          >
                            Open Shell
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'clusters':
        return (
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in-95 duration-500">
            <div className="text-center py-12">
               <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                 <Globe className="w-10 h-10 text-blue-600" />
               </div>
               <h2 className="text-3xl font-bold tracking-tight mb-2">Cluster Management</h2>
               <p className="text-gray-500 text-lg max-w-lg mx-auto">Group your servers into highly-available clusters and monitor distributed traffic.</p>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div
                 onClick={() => setCurrentView('fleet')}
                 className="bg-white border border-gray-200 rounded-2xl p-8 hover:border-blue-500 transition-colors cursor-pointer group"
                 role="button"
                 tabIndex={0}
               >
                  <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-all">
                    <Plus className="w-6 h-6 text-gray-400 group-hover:text-white" />
                  </div>
                  <h4 className="font-bold text-xl mb-1">Create K3s Cluster</h4>
                  <p className="text-sm text-gray-400 font-medium">Select nodes from Fleet and bootstrap K3s.</p>
               </div>
               <div
                 onClick={() => setIsTrafficModalOpen(true)}
                 className="bg-white border border-gray-200 rounded-2xl p-8 hover:border-blue-500 transition-colors cursor-pointer group"
                 role="button"
                 tabIndex={0}
               >
                  <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-all">
                    <Activity className="w-6 h-6 text-gray-400 group-hover:text-white" />
                  </div>
                  <h4 className="font-bold text-xl mb-1">Traffic Overview</h4>
                  <p className="text-sm text-gray-400 font-medium">Show RX/TX totals across your fleet.</p>
               </div>
            </div>
          </div>
        );
      case 'storage':
        return (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
            <div className="flex items-center justify-between">
              <h3 className="text-2xl font-bold tracking-tight">Fleet Storage</h3>
              <div className="flex gap-2">
                <div className="px-3 py-1 bg-white border border-gray-200 rounded-lg text-xs font-bold text-gray-500">
                  REAL-TIME MONITORING
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {servers.length === 0 ? (
                <div className="col-span-full py-20 text-center text-gray-400 font-medium">Add servers to monitor disk health</div>
              ) : (
                servers.map(s => (
                  <StorageNode key={s.id} server={s} />
                ))
              )}
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className="max-w-2xl mx-auto space-y-10 animate-in fade-in duration-500 pb-20">
            <section className="space-y-4">
              <h4 className="text-sm font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
                <Settings className="w-4 h-4" /> Global Infrastructure
              </h4>
              <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm divide-y divide-gray-100">
                <div className="p-6 flex items-center justify-between">
                  <div>
                    <p className="font-bold">SSH Port Default</p>
                    <p className="text-xs text-gray-500 font-medium">Global default port for host discovery.</p>
                  </div>
                  <input type="number" defaultValue={22} className="w-20 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm font-mono text-center outline-none focus:border-blue-500" />
                </div>
                <div className="p-6 flex items-center justify-between">
                  <div>
                    <p className="font-bold">Automatic Sync</p>
                    <p className="text-xs text-gray-500 font-medium">Update node status every 60 seconds.</p>
                  </div>
                  <div className="w-12 h-6 bg-blue-600 rounded-full relative">
                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h4 className="text-sm font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
                <Shield className="w-4 h-4" /> Security & Auth
              </h4>
              <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                <button
                  onClick={() => setIsKeysModalOpen(true)}
                  className="w-full p-6 flex items-center justify-between hover:bg-gray-50 transition-colors"
                >
                  <div className="text-left">
                    <p className="font-bold">Global SSH Keys</p>
                    <p className="text-xs text-gray-500 font-medium tracking-tight">Manage RSA/ED25519 keys for frictionless connect.</p>
                  </div>
                  <Plus className="w-5 h-5 text-gray-300" />
                </button>
              </div>
            </section>

            <div className="p-6 bg-amber-50 border border-amber-100 rounded-2xl flex gap-4">
              <div className="bg-amber-100 p-2 rounded-xl h-fit">
                <AlertCircle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-bold text-amber-900 mb-1">Maintenance Mode</p>
                <p className="text-xs text-amber-700 leading-relaxed">
                  Enabling maintenance mode will pause all automated deployments and background sync tasks across the control plane.
                </p>
                <button
                  onClick={() => setMaintenanceMode(m => !m)}
                  className="mt-3 px-4 py-2 bg-amber-600 text-white rounded-lg text-xs font-bold hover:bg-amber-700 transition-all shadow-sm shadow-amber-600/20"
                >
                  {maintenanceMode ? 'Exit Maintenance Mode' : 'Enter Maintenance Mode'}
                </button>
              </div>
            </div>
          </div>
        );
      default:
    }
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-6 border-b border-gray-100 mb-2">
          <div className="flex items-center gap-3 text-slate-800">
            <img 
              src="/logo.png" 
              className="w-10 h-10 rounded-lg object-contain shadow-sm" 
              alt="KubeCast Logo" 
            />
            <div onClick={() => setCurrentView('fleet')} className="cursor-pointer">
              <h1 className="font-bold text-lg tracking-tight leading-none italic">Kube<span className="text-blue-600">Cast</span></h1>
              <p className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-0.5">Control Plane</p>
            </div>
          </div>
        </div>
        
        <nav className="flex-1 px-4 py-4 space-y-1">
          <NavItem 
            icon={<ServerIcon className="w-4 h-4" />} 
            label="Fleet Overview" 
            active={currentView === 'fleet'} 
            onClick={() => setCurrentView('fleet')}
          />
          <NavItem 
            icon={<TerminalIcon className="w-4 h-4" />} 
            label="SSH Terminals" 
            active={currentView === 'terminals'} 
            onClick={() => setCurrentView('terminals')}
          />
          <NavItem 
            icon={<Globe className="w-4 h-4" />} 
            label="Clusters" 
            active={currentView === 'clusters'} 
            onClick={() => setCurrentView('clusters')}
          />
          <NavItem 
            icon={<Database className="w-4 h-4" />} 
            label="Storage" 
            active={currentView === 'storage'} 
            onClick={() => setCurrentView('storage')}
          />
          <NavItem 
            icon={<Settings className="w-4 h-4" />} 
            label="Settings" 
            active={currentView === 'settings'} 
            onClick={() => setCurrentView('settings')}
          />
        </nav>

        <div className="p-6 border-t border-gray-100 bg-gray-50/50">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full animate-pulse ${loading ? 'bg-amber-400' : 'bg-green-500'}`} />
            <span className="text-[10px] text-gray-500 font-mono font-medium uppercase tracking-tight">Backend: Online</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 shrink-0">
          <div>
            <h2 className="text-lg font-semibold tracking-tight capitalize">{currentView.replace('-', ' ')} Summary</h2>
            <p className="text-[11px] text-gray-400 font-medium">Control and telemetry for your cloud infrastructure</p>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsAddModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors text-gray-600"
            >
              <Plus className="w-4 h-4" />
              Add Host
            </button>
            <button
              onClick={() => {
                if (servers.length === 1) {
                  if (maintenanceMode) return;
                  setAutoDeployOnConnect('full');
                  setActiveTerminal(servers[0]);
                  return;
                }
                setQuickDeployServerId(servers[0]?.id || '');
                setIsQuickDeployOpen(true);
              }}
              disabled={servers.length === 0 || maintenanceMode}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm ${
                servers.length === 0 || maintenanceMode
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
                  : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-600/20'
              }`}
            >
              Quick Deploy
            </button>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-8 terminal-scrollbar">
          {renderView()}
        </div>

        {/* Status Bar */}
        <footer className="h-10 bg-white border-t border-gray-200 px-8 flex items-center justify-between shrink-0 text-slate-800">
          <div className="flex items-center gap-4 text-[10px] text-gray-400 font-bold uppercase tracking-wider">
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> API READY</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> TUNNEL UP</span>
          </div>
          <div className="text-[10px] text-gray-400 font-mono">
            SYNC: {new Date().toLocaleTimeString()} UTC
          </div>
        </footer>
      </main>

      {/* Overlays */}
      <AnimatePresence>
        {activeTerminal && (
          <TerminalOverlay
            server={activeTerminal}
            autoDeploy={autoDeployOnConnect}
            autoRun={autoRunOnConnect}
            onClose={() => {
              setActiveTerminal(null);
              setAutoDeployOnConnect(null);
              setAutoRunOnConnect(null);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isAddModalOpen && (
          <AddModal onAdd={addServer} onClose={() => setIsAddModalOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isQuickDeployOpen && (
          <QuickDeployModal
            servers={servers}
            selectedServerId={quickDeployServerId}
            onChangeSelected={setQuickDeployServerId}
            onClose={() => setIsQuickDeployOpen(false)}
            onStart={() => {
              const target = servers.find(s => s.id === quickDeployServerId) || servers[0];
              if (!target) return;
              setIsQuickDeployOpen(false);
              if (maintenanceMode) return;
              setAutoDeployOnConnect('full');
              setActiveTerminal(target);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isKeysModalOpen && (
          <InfoModal
            title="Global SSH Keys"
            body="Key management is wired to the UI now. Next step is using keys for authentication in addition to passwords."
            primaryLabel="Close"
            onPrimary={() => setIsKeysModalOpen(false)}
            onClose={() => setIsKeysModalOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isTrafficModalOpen && (
          <TrafficModal
            onClose={() => setIsTrafficModalOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {serverSettings && (
          <ServerSettingsModal
            server={serverSettings}
            maintenanceMode={maintenanceMode}
            onClose={() => setServerSettings(null)}
            onOpenShell={() => {
              setServerSettings(null);
              setActiveTerminal(serverSettings);
            }}
            onQuickDeploy={() => {
              if (maintenanceMode) return;
              setServerSettings(null);
              setAutoDeployOnConnect('full');
              setActiveTerminal(serverSettings);
            }}
            onVerify={() => {
              setServerSettings(null);
              setAutoRunOnConnect({ kind: 'deploy', label: 'Verify Stack', scriptType: 'verify' });
              setActiveTerminal(serverSettings);
            }}
            onAnalyzeLogs={() => {
              setServerSettings(null);
              setAutoRunOnConnect({
                kind: 'input',
                label: 'Analyze Log Bloat',
                command: 'sudo sh -lc \'du -h -d2 /var/log 2>/dev/null | sort -h | tail -n 30\'',
              });
              setActiveTerminal(serverSettings);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function NavItem({ icon, label, active = false, onClick }: { icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active ? 'bg-blue-50 text-blue-700 shadow-sm shadow-blue-100/50' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({ label, value, trend, trendColor, percentage, variant = "blue" }: any) {
  return (
    <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm transition-shadow hover:shadow-md">
      <div className="text-[10px] text-gray-400 uppercase tracking-widest font-bold mb-1">{label}</div>
      <div className="text-3xl font-light text-gray-800 tracking-tight">{value}</div>
      {trend ? (
        <div className={`mt-2 flex items-center gap-1 text-[11px] font-medium ${trendColor}`}>
          {trendColor?.includes('green') && <CheckCircle2 className="w-3 h-3" />}
          {trend}
        </div>
      ) : (
        <div className="mt-4 w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
          <div className={`h-full ${variant === 'orange' ? 'bg-orange-400' : 'bg-blue-500'}`} style={{ width: `${percentage}%` }} />
        </div>
      )}
    </div>
  );
}



function ServerCard({
  server,
  onDelete,
  onTerminal,
  onSettings,
  history,
}: {
  server: Server;
  onDelete: (id: string) => void;
  onTerminal: () => void;
  onSettings: () => void;
  history: Array<{ ts: number; cpu?: number; ram?: number; load1?: number; rxMb?: number; txMb?: number }>;
}) {
  const [telemetry, setTelemetry] = useState<{ cpu?: string, ram?: string, disk?: string, docker?: string, k3s?: string } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [monitoringOpen, setMonitoringOpen] = useState(false);

  useEffect(() => {
    fetchTelemetry();
  }, [server.id]);

  const fetchTelemetry = async () => {
    setFetching(true);
    try {
      const res = await fetch(`/api/servers/${server.id}/telemetry`);
      const data = await res.json();
      if (!data.error) setTelemetry(data);
    } catch (error) {
      console.error('Telemetry failed', error);
    } finally {
      setFetching(false);
    }
  };

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white border border-gray-200 rounded-2xl p-6 group hover:border-blue-300 hover:shadow-lg transition-all"
    >
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-sm ${
            server.status === 'online' || telemetry 
            ? 'bg-blue-50 border-blue-100 text-blue-600' 
            : 'bg-gray-50 border-gray-100 text-gray-400'
          }`}>
            {fetching ? <Loader2 className="w-5 h-5 animate-spin" /> : <ServerIcon className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="font-bold text-gray-800 leading-tight">{server.name}</h3>
            <p className="text-[11px] text-gray-400 font-mono tracking-tight">{server.username}@{server.host}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button 
            onClick={fetchTelemetry}
            className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
            title="Refresh Heartbeat"
          >
            <Activity className="w-4 h-4" />
          </button>
          <button 
            onClick={onTerminal}
            className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
            title="Terminal"
          >
            <TerminalIcon className="w-4 h-4" />
          </button>
          <button 
            onClick={() => onDelete(server.id)}
            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
            title="Remove"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3 mb-6">
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400 font-medium">CPU Load / RAM</span>
          <span className="font-mono font-bold text-gray-600">
            {telemetry && telemetry.cpu && telemetry.ram ? `${telemetry.cpu}% / ${telemetry.ram}%` : '---'}
          </span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400 font-medium">Docker Status</span>
          {telemetry?.docker && telemetry.docker !== 'none' ? (
            <span className="text-blue-600 font-mono font-bold text-[10px] uppercase">Installed</span>
          ) : (
            <span className={`text-[10px] font-bold uppercase ${telemetry ? 'text-gray-300' : 'text-gray-200 animate-pulse'}`}>
              Checking...
            </span>
          )}
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400 font-medium">K8s Runtime</span>
          {telemetry?.k3s && telemetry.k3s !== 'none' ? (
            <span className="text-emerald-500 font-mono font-bold text-[10px] uppercase">Active</span>
          ) : (
            <span className="text-gray-300 italic text-[10px] uppercase">Not Node</span>
          )}
        </div>
      </div>

      <div className="mb-5">
        <button
          onClick={() => setMonitoringOpen(o => !o)}
          className="w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 hover:bg-gray-100 transition-colors"
        >
          <span>Monitoring</span>
          <span className="font-mono text-[10px]">{monitoringOpen ? 'Hide' : 'Show'}</span>
        </button>

        {monitoringOpen && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">CPU</span>
                <span className="text-[10px] font-mono font-bold text-gray-600">{telemetry?.cpu ? `${telemetry.cpu}%` : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.cpu === 'number' ? p.cpu : null))} color="#2563eb" height={44} />
            </div>

            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">RAM</span>
                <span className="text-[10px] font-mono font-bold text-gray-600">{telemetry?.ram ? `${telemetry.ram}%` : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.ram === 'number' ? p.ram : null))} color="#10b981" height={44} />
            </div>

            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">LOAD (1m)</span>
                <span className="text-[10px] font-mono font-bold text-gray-600">{history.length && typeof history[history.length - 1]?.load1 === 'number' ? history[history.length - 1].load1!.toFixed(2) : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.load1 === 'number' ? p.load1 : null))} color="#f59e0b" height={44} normalize="auto" />
            </div>

            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">NET</span>
                <span className="text-[10px] font-mono font-bold text-gray-600">
                  {history.length && typeof history[history.length - 1]?.rxMb === 'number' && typeof history[history.length - 1]?.txMb === 'number'
                    ? `RX ${history[history.length - 1].rxMb!.toFixed(1)} / TX ${history[history.length - 1].txMb!.toFixed(1)}`
                    : '—'}
                </span>
              </div>
              <Sparkline values={history.map(p => (typeof p.txMb === 'number' ? p.txMb : null))} color="#a855f7" height={44} normalize="auto" />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
         <button 
           onClick={onTerminal}
           className="flex-1 text-[11px] font-bold uppercase tracking-widest py-2.5 rounded-lg bg-gray-50 border border-gray-100 hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-all text-gray-500 shadow-sm"
         >
           Access Node
         </button>
         <button
           onClick={onSettings}
           className="p-2.5 bg-gray-50 border border-gray-100 rounded-lg hover:border-gray-300 transition-colors"
           title="Server Settings"
         >
            <Settings className="w-4 h-4 text-gray-400" />
         </button>
      </div>
    </motion.div>
  );
}

function TerminalOverlay({
  server,
  autoDeploy,
  autoRun,
  onClose,
}: {
  server: Server;
  autoDeploy: null | 'full';
  autoRun: null | { kind: 'input'; label: string; command: string } | { kind: 'deploy'; label: string; scriptType: 'verify' };
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<string[]>(['Initializing secure handshake...', 'Target: ' + server.host]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Connecting...');
  const ws = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoDeployFired = useRef(false);
  const autoRunFired = useRef(false);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.current = new WebSocket(`${protocol}//${window.location.host}/ws/ssh`);
    
    ws.current.onopen = () => {
      ws.current?.send(JSON.stringify({ 
        type: 'connect', 
        serverId: server.id
      }));
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'data') {
        setLogs(prev => [...prev, data.data]);
      } else if (data.type === 'status') {
        setStatus(data.data);
        if (data.data === 'Connected' && autoDeploy === 'full' && !autoDeployFired.current) {
          autoDeployFired.current = true;
          setLogs(prev => [...prev, '', '\x1b[36mAuto-deploy triggered: Full Stack (curl → docker → k3s)\x1b[0m', '']);
          ws.current?.send(JSON.stringify({ type: 'deploy', scriptType: 'full' }));
        }
        if (data.data === 'Connected' && autoRun && !autoRunFired.current) {
          autoRunFired.current = true;
          setLogs(prev => [...prev, '', `\x1b[36mAuto-run: ${autoRun.label}\x1b[0m`, '']);
          if (autoRun.kind === 'input') {
            ws.current?.send(JSON.stringify({ type: 'input', data: autoRun.command + '\n' }));
          } else {
            ws.current?.send(JSON.stringify({ type: 'deploy', scriptType: autoRun.scriptType }));
          }
        }
      } else if (data.type === 'error') {
        setLogs(prev => [...prev, `\x1b[31mError: ${data.data}\x1b[0m`]);
        setStatus('Failed');
      }
    };

    return () => ws.current?.close();
  }, [server, autoDeploy, autoRun]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || !ws.current) return;
    ws.current.send(JSON.stringify({ type: 'input', data: input + '\n' }));
    setInput('');
  };

  const handleDeploy = (type: 'docker' | 'k3s' | 'full' | 'verify') => {
    ws.current?.send(JSON.stringify({ type: 'deploy', scriptType: type }));
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/40 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        className="glass-terminal border border-white/10 rounded-2xl w-full max-w-4xl h-[600px] flex flex-col shadow-2xl overflow-hidden"
      >
        <div className="h-14 border-b border-white/5 flex items-center justify-between px-6 bg-white/5">
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500/80 shadow-sm" />
              <div className="w-3 h-3 rounded-full bg-amber-500/80 shadow-sm" />
              <div className="w-3 h-3 rounded-full bg-emerald-500/80 shadow-sm" />
            </div>
            <div className="h-4 w-px bg-white/10 mx-2" />
            <span className="text-[11px] font-mono text-gray-400">
              {server.username}@<span className="text-blue-400">{server.host}</span> &mdash; <span className="text-gray-100">{status}</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
             <div className="flex gap-2">
                <button 
                  onClick={() => handleDeploy('docker')}
                  className="text-[10px] bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-500 transition-colors uppercase font-bold shadow-sm shadow-blue-600/10"
                >
                  Install Docker
                </button>
                <button 
                  onClick={() => handleDeploy('k3s')}
                  className="text-[10px] bg-white/10 text-white border border-white/10 px-3 py-1.5 rounded-md hover:bg-white/20 transition-colors uppercase font-bold"
                >
                  Bootstrap K3s
                </button>
                <button
                  onClick={() => handleDeploy('full')}
                  className="text-[10px] bg-emerald-500/90 text-white px-3 py-1.5 rounded-md hover:bg-emerald-400 transition-colors uppercase font-bold"
                >
                  Full Stack
                </button>
                <button
                  onClick={() => handleDeploy('verify')}
                  className="text-[10px] bg-white/10 text-white border border-white/10 px-3 py-1.5 rounded-md hover:bg-white/20 transition-colors uppercase font-bold"
                >
                  Verify
                </button>
             </div>
             <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors ml-2">
               <X className="w-5 h-5" />
             </button>
          </div>
        </div>

        <div 
          ref={scrollRef}
          className="flex-1 p-6 font-mono text-[13px] overflow-y-auto terminal-scrollbar whitespace-pre-wrap leading-relaxed selection:bg-blue-500/40 text-gray-300"
        >
          {logs.map((log, i) => (
            <div key={i} className="mb-0.5">{log}</div>
          ))}
          <form onSubmit={handleSend} className="inline-flex items-center w-full mt-2">
             <span className="text-blue-400 mr-2 font-bold">❯</span>
             <input 
               autoFocus
               value={input}
               onChange={(e) => setInput(e.target.value)}
               className="bg-transparent border-none outline-none flex-1 text-gray-100"
               placeholder="Execute command..."
             />
          </form>
        </div>
      </motion.div>
    </motion.div>
  );
}

function QuickDeployModal({
  servers,
  selectedServerId,
  onChangeSelected,
  onStart,
  onClose,
}: {
  servers: Server[];
  selectedServerId: string;
  onChangeSelected: (id: string) => void;
  onStart: () => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg p-7 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Quick Deploy</h2>
            <p className="text-xs text-gray-500 font-medium">Connect via SSH, then auto-install curl → Docker → Kubernetes.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] uppercase font-bold text-gray-400 tracking-wider ml-1">Target host</label>
          <select
            value={selectedServerId}
            onChange={(e) => onChangeSelected(e.target.value)}
            className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all text-gray-900"
          >
            {servers.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.username}@{s.host})
              </option>
            ))}
          </select>
        </div>

        <div className="pt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 px-4 rounded-xl border border-gray-100 bg-gray-50 hover:bg-gray-100 text-gray-600 font-bold transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onStart}
            className="flex-1 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20"
          >
            Start Auto Deploy
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MonitoringCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
      <div className="mb-4">
        <div className="font-bold text-gray-800">{title}</div>
        <div className="text-[11px] text-gray-400 font-medium">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function Sparkline({
  values,
  color,
  normalize,
  height = 80,
}: {
  values: Array<number | null>;
  color: string;
  normalize?: 'auto';
  height?: number;
}) {
  const width = 360;
  const clean = values.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const present = clean.filter((v): v is number => typeof v === 'number');
  const min = present.length ? Math.min(...present) : 0;
  const max = present.length ? Math.max(...present) : 1;
  const span = max - min || 1;

  const points = clean.map((v, idx) => {
    const x = (idx / Math.max(1, clean.length - 1)) * width;
    if (v == null) return { x, y: height / 2, ok: false };
    const y = height - ((v - min) / span) * height;
    return { x, y, ok: true };
  });

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.95" />
    </svg>
  );
}

function InfoModal({
  title,
  body,
  primaryLabel,
  onPrimary,
  onClose,
}: {
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg p-7 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-gray-900">{title}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-gray-600">{body}</p>
        <div className="pt-6 flex justify-end">
          <button onClick={onPrimary} className="py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20">
            {primaryLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TrafficModal({ onClose }: { onClose: () => void }) {
  return (
    <InfoModal
      title="Traffic Overview"
      body="Traffic charts are now fed by net_rx_mb / net_tx_mb telemetry (fleet totals will be plotted next)."
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
    />
  );
}

function ServerSettingsModal({
  server,
  maintenanceMode,
  onClose,
  onOpenShell,
  onQuickDeploy,
  onVerify,
  onAnalyzeLogs,
}: {
  server: Server;
  maintenanceMode: boolean;
  onClose: () => void;
  onOpenShell: () => void;
  onQuickDeploy: () => void;
  onVerify: () => void;
  onAnalyzeLogs: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg p-7 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-bold text-gray-900">{server.name}</div>
            <div className="text-[11px] text-gray-500 font-mono">{server.username}@{server.host}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onOpenShell} className="py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 font-bold text-sm">
            Open Shell
          </button>
          <button onClick={onVerify} className="py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 font-bold text-sm">
            Verify Stack
          </button>
          <button
            onClick={onQuickDeploy}
            disabled={maintenanceMode}
            className={`py-3 px-4 rounded-xl font-bold text-sm ${maintenanceMode ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/20'}`}
          >
            Quick Deploy
          </button>
          <button onClick={onAnalyzeLogs} className="py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 font-bold text-sm">
            Analyze Logs
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AddModal({ onAdd, onClose }: { onAdd: (s: any) => void, onClose: () => void }) {
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    username: 'root',
    port: 22,
    password: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAdd(formData);
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/20 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg p-8 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Connect New Infrastructure</h2>
            <p className="text-sm text-gray-500 font-medium">Securely link a remote host via SSH.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input 
              label="Node Name" 
              value={formData.name} 
              onChange={e => setFormData({...formData, name: e.target.value})} 
              placeholder="e.g. Frankfurt-Node-01"
              required
            />
            <Input 
              label="Public IP / Host" 
              value={formData.host} 
              onChange={e => setFormData({...formData, host: e.target.value})} 
              placeholder="10.0.x.x or nodes.io"
              required
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <Input 
              label="SSH User" 
              value={formData.username} 
              onChange={e => setFormData({...formData, username: e.target.value})} 
              required
            />
            <Input 
              label="SSH Port" 
              type="number"
              value={formData.port.toString()} 
              onChange={e => setFormData({...formData, port: parseInt(e.target.value)})} 
              required
            />
          </div>

          <Input 
            label="Root Password" 
            type="password"
            value={formData.password} 
            onChange={e => setFormData({...formData, password: e.target.value})} 
            placeholder="Used only for authentication"
            required
          />

          <div className="pt-4 flex gap-3">
            <button 
              type="button" 
              onClick={onClose}
              className="flex-1 py-3 px-4 rounded-xl border border-gray-100 bg-gray-50 hover:bg-gray-100 text-gray-600 font-bold transition-all"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="flex-1 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20"
            >
              Link Node
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

function Input({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5 flex-1">
      <label className="text-[10px] uppercase font-bold text-gray-400 tracking-wider ml-1">{label}</label>
      <input 
        {...props}
        className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all text-gray-900 placeholder:text-gray-300"
      />
    </div>
  );
}

function StorageNode({ server }: { server: Server }) {
  const [telemetry, setTelemetry] = useState<{ disk?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDisk = async () => {
      try {
        const res = await fetch(`/api/servers/${server.id}/telemetry`);
        const data = await res.json();
        if (!data.error) setTelemetry(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchDisk();
  }, [server.id]);

  const usagePercent = telemetry?.disk ? parseInt(telemetry.disk.replace('%', '')) : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm hover:border-blue-300 transition-all">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-50 rounded-lg">
            <Database className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <span className="font-bold block text-sm">{server.name}</span>
            <span className="text-[10px] text-gray-400 font-mono italic">ssh://{server.host}</span>
          </div>
        </div>
        {loading ? (
          <Loader2 className="w-4 h-4 text-gray-300 animate-spin" />
        ) : (
          <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tight ${usagePercent > 80 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
            {usagePercent > 80 ? 'Heavy Load' : 'Stable'}
          </div>
        )}
      </div>
      
      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-[11px] mb-2">
            <span className="text-gray-500 font-bold uppercase tracking-wider">Storage Usage (/)</span>
            <span className="text-gray-900 font-mono font-bold">{loading ? '---' : telemetry?.disk || 'Unknown'}</span>
          </div>
          <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden border border-gray-100/50">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${usagePercent}%` }}
              className={`h-full transition-all duration-1000 ${
                usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-amber-400' : 'bg-blue-600'
              }`} 
            />
          </div>
        </div>

        <div className="pt-4 flex items-center justify-between border-t border-gray-50 mt-2">
          <span className="text-[10px] text-gray-400 font-medium">Auto-scaling: <span className="text-gray-600 font-bold italic">Manual Only</span></span>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('kubecast:analyze-logs', { detail: { serverId: server.id } }));
            }}
            className="text-[10px] font-bold text-blue-600 hover:text-blue-700 uppercase tracking-widest flex items-center gap-1 transition-colors"
          >
            Analyze Log Bloat <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
