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
  ArrowRight,
  Play,
  LayoutGrid,
  ExternalLink,
  FileText,
  RefreshCw,
  Search,
  Sun,
  Moon,
  Box,
  Cpu,
  Zap,
  Network,
  ArrowDown,
  ArrowUp,
  HardDrive
} from 'lucide-react';
import { motion, AnimatePresence, useDragControls } from 'motion/react';
import { Server, ClusterState } from './types';

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [clusters, setClusters] = useState<ClusterState[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [darkMode, setDarkMode] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isCreateClusterModalOpen, setIsCreateClusterModalOpen] = useState(false);
  const [activeTerminal, setActiveTerminal] = useState<Server | null>(null);
  const [autoDeployOnConnect, setAutoDeployOnConnect] = useState<null | 'full'>(null);
  const [autoRunOnConnect, setAutoRunOnConnect] = useState<
    null | { kind: 'input'; label: string; command: string } | { kind: 'deploy'; label: string; scriptType: 'verify' | 'template'; templateConfig?: any }
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
  const [currentView, setCurrentView] = useState<'fleet' | 'terminals' | 'apps' | 'clusters' | 'storage' | 'settings' | 'monitoring'>('fleet');
  const [deployingSample, setDeployingSample] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [isProdSimulationOpen, setIsProdSimulationOpen] = useState(false);
  const [simulationCluster, setSimulationCluster] = useState<ClusterState | null>(null);
  const [nuclearTarget, setNuclearTarget] = useState<Server | null>(null);
  const [nuclearStep, setNuclearStep] = useState<0 | 1 | 2>(0);
  const [destroying, setDestroying] = useState<string | null>(null);
  const [deployDockerServer, setDeployDockerServer] = useState<Server | null>(null);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [_templateConfig, _setTemplateConfig] = useState<any>(null);

  useEffect(() => {
    fetchServers();
    fetchClusters();
  }, []);

  // Fetch clusters from backend
  const fetchClusters = async () => {
    try {
      const res = await fetch('/api/clusters');
      const data = await res.json();
      setClusters(data);
    } catch (error) {
      console.error('Failed to fetch clusters', error);
    }
  };

  // Add cluster
  const addCluster = async (clusterData: Partial<ClusterState>) => {
    try {
      const res = await fetch('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clusterData),
      });
      const newCluster = await res.json();
      setClusters([...clusters, newCluster]);
    } catch (error) {
      console.error('Failed to add cluster', error);
    }
  };

  // Update cluster


  // Delete cluster
  const deleteCluster = async (id: string) => {
    if (!confirm('Are you sure you want to remove this cluster?')) return;
    try {
      await fetch(`/api/clusters/${id}`, { method: 'DELETE' });
      setClusters(clusters.filter(c => c.id !== id));
    } catch (error) {
      console.error('Failed to delete cluster', error);
    }
  };

  useEffect(() => {
    if (currentView === 'clusters') fetchClusters();
  }, [currentView]);

  // Existing effect
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
    if (!confirm('Are you sure you want to remove this server from the control plane? (This will NOT uninstall software)')) return;
    try {
      await fetch(`/api/servers/${id}`, { method: 'DELETE' });
      setServers(servers.filter(s => s.id !== id));
    } catch (error) {
      console.error('Failed to delete server', error);
    }
  };

  const destroyServer = async (id: string) => {
    setDestroying(id);
    try {
      const res = await fetch(`/api/servers/${id}/destroy`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setServers(servers.filter(s => s.id !== id));
        alert('Server has been wiped and removed from fleet.');
      } else {
        alert('Cleanup failed: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to destroy server', error);
      alert('A connection error occurred during destruction.');
    } finally {
      setDestroying(null);
      setNuclearTarget(null);
      setNuclearStep(0);
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
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-1 duration-300">
            <div className="grid grid-cols-4 gap-6">
              <StatCard
                label="Active Nodes"
                value={servers.length.toString()}
                trend={servers.length > 0 ? "System healthy" : "Fleet offline"}
                trendColor={servers.length > 0 ? "text-green-600" : "text-gray-400"}
                darkMode={darkMode}
              />
              <StatCard
                label="Docker Hosts"
                value={servers.filter(s => s.installed.docker).length.toString()}
                trend={servers.length > 0 ? "Runtime active" : "No runtimes"}
                trendColor="text-gray-400"
                darkMode={darkMode}
              />
              <StatCard
                label="K8s Nodes"
                value={servers.filter(s => s.installed.k8s).length.toString()}
                percentage={servers.length > 0 ? (servers.filter(s => s.installed.k8s).length / servers.length) * 100 : 0}
                darkMode={darkMode}
              />
              <StatCard
                label="Resource Load"
                value={servers.length === 0 ? "0%" : (avgLoad == null ? "—" : `${avgLoad.toFixed(1)}%`)}
                percentage={avgLoad == null ? 0 : Math.max(0, Math.min(100, avgLoad))}
                variant="orange"
                darkMode={darkMode}
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
                <>
                  {sortedServers
                    .filter(s =>
                      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                      s.host.toLowerCase().includes(searchTerm.toLowerCase())
                    )
                    .map((server) => (
                      <ServerCard
                        key={server.id}
                        server={server}
                        darkMode={darkMode}
                        onDelete={deleteServer}
                        onTerminal={() => setActiveTerminal(server)}
                        onSettings={() => setServerSettings(server)}
                        onNuke={() => {
                          setNuclearTarget(server);
                          setNuclearStep(1);
                        }}
                        history={telemetryHistoryByServerId[server.id] || []}
                      />
                    ))}
                </>
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
              <div className={`w-20 h-20 ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'} rounded-full flex items-center justify-center mx-auto mb-6`}>
                <Globe className="w-10 h-10 text-blue-500" />
              </div>
              <h2 className={`text-3xl font-bold tracking-tight mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Cluster Management</h2>
              <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'} text-lg max-w-lg mx-auto`}>Group your servers into highly-available clusters and monitor distributed traffic.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div
                onClick={() => setIsCreateClusterModalOpen(true)}
                className={`${darkMode ? 'bg-gray-900 border-white/5 hover:border-blue-500/50' : 'bg-white border-gray-200 hover:border-blue-500'} border rounded-2xl p-8 transition-all cursor-pointer group`}
                role="button"
                tabIndex={0}
              >
                <div className={`w-12 h-12 ${darkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-50 text-gray-400'} rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-all`}>
                  <Plus className="w-6 h-6" />
                </div>
                <h4 className={`font-bold text-xl mb-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Create K3s Cluster</h4>
                <p className="text-sm text-gray-400 font-medium">Select nodes from Fleet and bootstrap K3s.</p>
              </div>
              <div
                onClick={() => setIsTrafficModalOpen(true)}
                className={`${darkMode ? 'bg-gray-900 border-white/5 hover:border-blue-500/50' : 'bg-white border-gray-200 hover:border-blue-500'} border rounded-2xl p-8 transition-all cursor-pointer group`}
                role="button"
                tabIndex={0}
              >
                <div className={`w-12 h-12 ${darkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-50 text-gray-400'} rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-all`}>
                  <Activity className="w-6 h-6" />
                </div>
                <h4 className={`font-bold text-xl mb-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Traffic Overview</h4>
                <p className="text-sm text-gray-400 font-medium">Show RX/TX totals across your fleet.</p>
              </div>
            </div>

            {clusters.length > 0 ? (
              <div className="mt-8">
                <h3 className={`text-xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Your Clusters</h3>
                <div className="grid grid-cols-1 gap-4">
                  {clusters.map(cluster => (
                    <div key={cluster.id} className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm`}>
                      <div>
                        <div className={`font-bold text-lg ${darkMode ? 'text-white' : 'text-gray-900'}`}>{cluster.name}</div>
                        <div className="text-sm text-gray-500">{cluster.serverIds.length} nodes attached</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={async () => {
                            setDeployingSample(cluster.id);
                            setDeployResult(null);
                            const res = await fetch(`/api/clusters/${cluster.id}/deploy-sample`, { method: 'POST' });
                            const data = await res.json();
                            setDeployResult(data);
                            setDeployingSample(null);
                          }}
                          disabled={!!deployingSample}
                          className={`px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm ${deployingSample === cluster.id ? 'bg-green-200 text-green-900 cursor-wait' : 'bg-green-600 text-white hover:bg-green-700'}`}
                        >
                          {deployingSample === cluster.id ? 'Deploying...' : 'Deploy Prod Simulation'}
                        </button>
                        <button
                          onClick={async () => {
                            setDeployingSample(cluster.id + '-load');
                            const res = await fetch(`/api/clusters/${cluster.id}/simulate-load`, { method: 'POST' });
                            const data = await res.json();
                            setDeployResult(data);
                            setDeployingSample(null);
                            setSimulationCluster(cluster);
                            setIsProdSimulationOpen(true);
                          }}
                          disabled={!!deployingSample}
                          className={`px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm ${deployingSample === cluster.id + '-load' ? 'bg-orange-200 text-orange-900 cursor-wait' : 'bg-orange-500 text-white hover:bg-orange-600'}`}
                        >
                          {deployingSample === cluster.id + '-load' ? 'Simulating...' : 'Run Simulation'}
                        </button>
                        <button
                          onClick={() => deleteCluster(cluster.id)}
                          className={`px-3 py-2 rounded-lg transition-colors ${darkMode ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'}`}
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={`mt-8 text-center py-12 border-2 border-dashed rounded-2xl ${darkMode ? 'border-white/5 text-gray-500' : 'border-gray-200 text-gray-400 font-medium'}`}>
                No clusters created yet. Click "Create K3s Cluster" to start.
              </div>
            )}

            {deployResult && (
              <div className={`mt-4 p-4 border rounded-xl text-xs text-left font-mono whitespace-pre-wrap ${darkMode ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-green-50 border-green-200 text-green-900'}`}>
                <div className="font-bold mb-1">Prod Simulation Deploy Result</div>
                {deployResult.results.map((r: any, i: number) => (
                  <div key={i} className="mb-2">
                    <div><b>Server:</b> {r.serverId}</div>
                    <div><b>Exit:</b> {r.code ?? '—'}</div>
                    <div><b>Output:</b> <span className="break-all">{r.output || '—'}</span></div>
                    {r.error && <div className={`font-bold ${darkMode ? 'text-red-400' : 'text-red-600'}`}><b>Error:</b> {r.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      case 'storage':
        return (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
            <div className="flex items-center justify-between">
              <h3 className={`text-2xl font-bold tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>Fleet Storage</h3>
              <div className="flex gap-2">
                <div className={`px-3 py-1 border rounded-lg text-[10px] font-bold ${darkMode ? 'bg-white/5 border-white/5 text-gray-400' : 'bg-white border-gray-200 text-gray-500'}`}>
                  REAL-TIME MONITORING
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {servers.length === 0 ? (
                <div className="col-span-full py-20 text-center text-gray-400 font-medium">Add servers to monitor disk health</div>
              ) : (
                servers.map(s => (
                  <StorageNode key={s.id} server={s} darkMode={darkMode} />
                ))
              )}
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className="max-w-2xl mx-auto space-y-10 animate-in fade-in duration-500 pb-20">
            <section className="space-y-4">
              <h4 className={`text-sm font-bold uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'} flex items-center gap-2`}>
                <Settings className="w-4 h-4" /> Global Infrastructure
              </h4>
              <div className={`${darkMode ? 'bg-gray-900 border-white/5 divide-white/5' : 'bg-white border-gray-200 divide-gray-100'} border rounded-2xl overflow-hidden shadow-sm divide-y`}>
                <div className="p-6 flex items-center justify-between">
                  <div>
                    <p className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>SSH Port Default</p>
                    <p className="text-xs text-gray-500 font-medium">Global default port for host discovery.</p>
                  </div>
                  <input
                    type="number"
                    defaultValue={22}
                    className={`w-20 border rounded-lg px-3 py-2 text-sm font-mono text-center outline-none transition-all ${darkMode ? 'bg-white/5 border-white/5 text-white focus:border-blue-500' : 'bg-gray-50 border-gray-100 focus:border-blue-500'}`}
                  />
                </div>
                <div className="p-6 flex items-center justify-between">
                  <div>
                    <p className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Automatic Sync</p>
                    <p className="text-xs text-gray-500 font-medium">Update node status every 60 seconds.</p>
                  </div>
                  <button
                    onClick={() => { }}
                    className={`w-12 h-6 rounded-full relative transition-colors ${darkMode ? 'bg-blue-600/50' : 'bg-blue-600'}`}
                  >
                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm" />
                  </button>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h4 className={`text-sm font-bold uppercase tracking-widest ${darkMode ? 'text-gray-500' : 'text-gray-400'} flex items-center gap-2`}>
                <Shield className="w-4 h-4" /> Security & Auth
              </h4>
              <div className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-2xl overflow-hidden shadow-sm`}>
                <button
                  onClick={() => setIsKeysModalOpen(true)}
                  className={`w-full p-6 flex items-center justify-between transition-colors ${darkMode ? 'hover:bg-white/5' : 'hover:bg-gray-50'}`}
                >
                  <div className="text-left">
                    <p className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Global SSH Keys</p>
                    <p className="text-xs text-gray-500 font-medium tracking-tight">Manage RSA/ED25519 keys for frictionless connect.</p>
                  </div>
                  <Plus className={`w-5 h-5 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} />
                </button>
              </div>
            </section>

            <div className={`p-6 border rounded-2xl flex gap-4 transition-colors ${darkMode ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-100'}`}>
              <div className={`p-2 rounded-xl h-fit ${darkMode ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                <AlertCircle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className={`text-sm font-bold mb-1 ${darkMode ? 'text-amber-400' : 'text-amber-900'}`}>Maintenance Mode</p>
                <p className={`text-xs leading-relaxed ${darkMode ? 'text-amber-500/80' : 'text-amber-700'}`}>
                  Enabling maintenance mode will pause all automated deployments and background sync tasks across the control plane.
                </p>
                <button
                  onClick={() => setMaintenanceMode(m => !m)}
                  className={`mt-3 px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm ${darkMode ? 'bg-amber-500 text-white hover:bg-amber-400 shadow-amber-500/20' : 'bg-amber-600 text-white hover:bg-amber-700 shadow-amber-600/20'}`}
                >
                  {maintenanceMode ? 'Exit Maintenance Mode' : 'Enter Maintenance Mode'}
                </button>
              </div>
            </div>
          </div>
        );
      case 'apps':
        return (
          <AppManagerView
            servers={servers}
            searchTerm={searchTerm}
            darkMode={darkMode}
            onOpenTerminal={(srv, auto) => {
              setActiveTerminal(srv);
              setAutoRunOnConnect(auto);
            }}
            setIsTemplateModalOpen={setIsTemplateModalOpen}
          />
        );
      case 'monitoring':
        return (
          <MonitoringView
            servers={servers}
            telemetryByServerId={telemetryByServerId}
            telemetryHistory={telemetryHistoryByServerId}
            darkMode={darkMode}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className={`flex h-screen ${darkMode ? 'bg-gray-950 text-white' : 'bg-gray-50 text-gray-900'} font-sans overflow-hidden transition-colors duration-300`}>
      {/* Sidebar */}
      <aside className={`w-64 ${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border-r flex flex-col shrink-0 transition-colors`}>
        <div className={`p-6 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} mb-2`}>
          <div className={`flex items-center gap-3 ${darkMode ? 'text-white' : 'text-slate-800'}`}>
            <img
              src="/logo.png"
              className="w-10 h-10 rounded-lg object-contain shadow-sm"
              alt="KubeCast Logo"
            />
            <div onClick={() => setCurrentView('fleet')} className="cursor-pointer">
              <h1 className={`font-bold text-lg tracking-tight leading-none italic ${darkMode ? 'text-white' : 'text-slate-800'}`}>Kube<span className="text-blue-500">Cast</span></h1>
              <p className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-0.5">Control Plane</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 py-4 space-y-1">
          <NavItem
            icon={<ServerIcon className="w-4 h-4" />}
            label="Fleet Overview"
            active={currentView === 'fleet'}
            darkMode={darkMode}
            onClick={() => setCurrentView('fleet')}
          />
          <NavItem
            icon={<TerminalIcon className="w-4 h-4" />}
            label="SSH Terminals"
            active={currentView === 'terminals'}
            darkMode={darkMode}
            onClick={() => setCurrentView('terminals')}
          />
          <NavItem
            icon={<LayoutGrid className="w-4 h-4" />}
            label="App Manager"
            active={currentView === 'apps'}
            darkMode={darkMode}
            onClick={() => setCurrentView('apps')}
          />
          <NavItem
            icon={<Activity className="w-4 h-4" />}
            label="System Monitoring"
            active={currentView === 'monitoring'}
            darkMode={darkMode}
            onClick={() => setCurrentView('monitoring')}
          />
          <NavItem
            icon={<Globe className="w-4 h-4" />}
            label="Clusters"
            active={currentView === 'clusters'}
            darkMode={darkMode}
            onClick={() => setCurrentView('clusters')}
          />
          <NavItem
            icon={<Database className="w-4 h-4" />}
            label="Storage"
            active={currentView === 'storage'}
            darkMode={darkMode}
            onClick={() => setCurrentView('storage')}
          />
          <NavItem
            icon={<Settings className="w-4 h-4" />}
            label="Settings"
            active={currentView === 'settings'}
            darkMode={darkMode}
            onClick={() => setCurrentView('settings')}
          />
        </nav>

        <div className={`p-6 border-t ${darkMode ? 'border-white/5 bg-white/5' : 'border-gray-100 bg-gray-50/50'}`}>
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full animate-pulse ${loading ? 'bg-amber-400' : 'bg-green-500'}`} />
            <span className={`text-[10px] ${darkMode ? 'text-gray-400' : 'text-gray-500'} font-mono font-medium uppercase tracking-tight`}>Backend: Online</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className={`h-16 shrink-0 border-b ${darkMode ? 'bg-gray-900/50 border-white/5 backdrop-blur-md' : 'bg-white border-gray-100'} px-8 flex items-center justify-between sticky top-0 z-10 transition-colors`}>
          <div className="flex-1 max-w-md relative group">
            <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${darkMode ? 'text-gray-500' : 'text-gray-400'} group-focus-within:text-blue-500 transition-colors`} />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search fleet, containers, or tags..."
              className={`w-full ${darkMode ? 'bg-white/5 border-white/10 text-white placeholder:text-gray-500' : 'bg-gray-100 border-gray-200 text-gray-900'} rounded-2xl pl-11 pr-4 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500 transition-all`}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2.5 rounded-xl border transition-all ${darkMode ? 'bg-white/5 border-white/10 text-amber-400 hover:bg-white/10' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg ${darkMode ? 'bg-white/10 border-white/10 text-white hover:bg-white/20' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
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
              className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg ${servers.length === 0 || maintenanceMode
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
        <footer className={`h-10 border-t px-8 flex items-center justify-between shrink-0 transition-colors ${darkMode ? 'bg-gray-900/80 border-white/5 text-gray-400' : 'bg-white border-gray-200 text-slate-800'}`}>
          <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-wider">
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> API READY</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> TUNNEL UP</span>
          </div>
          <div className="text-[10px] font-mono">
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
          <AddModal onAdd={addServer} darkMode={darkMode} onClose={() => setIsAddModalOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCreateClusterModalOpen && (
          <CreateClusterModal
            servers={servers}
            darkMode={darkMode}
            onCreate={async (data) => {
              await addCluster(data);
              setIsCreateClusterModalOpen(false);
            }}
            onClose={() => setIsCreateClusterModalOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isQuickDeployOpen && (
          <QuickDeployModal
            servers={servers}
            darkMode={darkMode}
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
            darkMode={darkMode}
            onPrimary={() => setIsKeysModalOpen(false)}
            onClose={() => setIsKeysModalOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {nuclearTarget && nuclearStep === 1 && (
          <NuclearWarningModal
            server={nuclearTarget}
            darkMode={darkMode}
            onConfirm={() => setNuclearStep(2)}
            onClose={() => {
              setNuclearTarget(null);
              setNuclearStep(0);
            }}
          />
        )}
        {nuclearTarget && nuclearStep === 2 && (
          <NuclearConfirmationModal
            server={nuclearTarget}
            isDestroying={destroying === nuclearTarget.id}
            darkMode={darkMode}
            onConfirm={() => destroyServer(nuclearTarget.id)}
            onClose={() => {
              setNuclearTarget(null);
              setNuclearStep(0);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isProdSimulationOpen && simulationCluster && (
          <ProdSimulationOverlay
            cluster={simulationCluster}
            darkMode={darkMode}
            onClose={() => {
              setIsProdSimulationOpen(false);
              setSimulationCluster(null);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isTrafficModalOpen && (
          <TrafficModal
            history={telemetryHistoryByServerId}
            darkMode={darkMode}
            onClose={() => setIsTrafficModalOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {serverSettings && (
          <ServerSettingsModal
            server={serverSettings}
            maintenanceMode={maintenanceMode}
            darkMode={darkMode}
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
            onNuke={() => {
              const target = serverSettings;
              setServerSettings(null);
              setNuclearTarget(target);
              setNuclearStep(1);
            }}
            onDeployDocker={() => {
              const target = serverSettings;
              setServerSettings(null);
              setDeployDockerServer(target);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deployDockerServer && (
          <DeployDockerfileModal
            server={deployDockerServer}
            darkMode={darkMode}
            onClose={() => setDeployDockerServer(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isTemplateModalOpen && (
          <DeployTemplateModal
            servers={servers}
            darkMode={darkMode}
            onClose={() => setIsTemplateModalOpen(false)}
            onStart={(srv, config) => {
              setIsTemplateModalOpen(false);
              if (maintenanceMode) return;
              setAutoRunOnConnect({
                kind: 'deploy',
                label: 'VPS Template',
                templateConfig: config,
                scriptType: 'template'
              } as any);
              setActiveTerminal(srv);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function NavItem({ icon, label, active = false, darkMode = false, onClick }: { icon: React.ReactNode, label: string, active?: boolean, darkMode?: boolean, onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all ${active
          ? (darkMode ? 'bg-blue-600/20 text-blue-400 shadow-lg shadow-blue-900/20' : 'bg-blue-50 text-blue-700 shadow-sm shadow-blue-100/50')
          : (darkMode ? 'text-gray-400 hover:bg-white/5' : 'text-gray-500 hover:bg-gray-100')
        }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({ label, value, trend, trendColor, percentage, variant = "blue", darkMode = false }: any) {
  return (
    <div className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} p-5 rounded-2xl border shadow-sm transition-shadow hover:shadow-md`}>
      <div className="text-[10px] text-gray-400 uppercase tracking-widest font-bold mb-1">{label}</div>
      <div className={`text-3xl font-light ${darkMode ? 'text-white' : 'text-gray-800'} tracking-tight`}>{value}</div>
      {trend ? (
        <div className={`mt-2 flex items-center gap-1 text-[11px] font-medium ${trendColor}`}>
          {trendColor?.includes('green') && <CheckCircle2 className="w-3 h-3" />}
          {trend}
        </div>
      ) : (
        <div className={`mt-4 w-full ${darkMode ? 'bg-white/10' : 'bg-gray-100'} h-1.5 rounded-full overflow-hidden`}>
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
  onNuke,
  history,
  darkMode = false,
}: {
  server: Server;
  onDelete: (id: string) => void;
  onTerminal: () => void;
  onSettings: () => void;
  onNuke: () => void;
  history: Array<{ ts: number; cpu?: number; ram?: number; load1?: number; rxMb?: number; txMb?: number }>;
  darkMode?: boolean;
}) {
  const [telemetry, setTelemetry] = useState<{ cpu?: string, ram?: string, disk?: string, docker?: string, k3s?: string } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  const [prodTest, setProdTest] = useState<{ running: boolean; result?: { code: number; output: string; error: string } } | null>(null);

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
      className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-2xl p-6 group hover:border-blue-500 hover:shadow-xl transition-all`}
    >
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-sm ${server.status === 'online' || telemetry
              ? (darkMode ? 'bg-blue-600/20 border-blue-500/20 text-blue-400' : 'bg-blue-50 border-blue-100 text-blue-600')
              : (darkMode ? 'bg-white/5 border-white/5 text-gray-600' : 'bg-gray-50 border-gray-100 text-gray-400')
            }`}>
            {fetching ? <Loader2 className="w-5 h-5 animate-spin" /> : <ServerIcon className="w-5 h-5" />}
          </div>
          <div>
            <h3 className={`font-bold leading-tight ${darkMode ? 'text-white' : 'text-gray-800'}`}>{server.name}</h3>
            <p className="text-[11px] text-gray-400 font-mono tracking-tight">{server.username}@{server.host}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={fetchTelemetry}
            className={`p-2 rounded-lg transition-all ${darkMode ? 'text-gray-400 hover:text-blue-400 hover:bg-white/5' : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'}`}
            title="Refresh Heartbeat"
          >
            <Activity className="w-4 h-4" />
          </button>
          <button
            onClick={onTerminal}
            className={`p-2 rounded-lg transition-all ${darkMode ? 'text-gray-400 hover:text-blue-400 hover:bg-white/5' : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'}`}
            title="Terminal"
          >
            <TerminalIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(server.id)}
            className={`p-2 rounded-lg transition-all ${darkMode ? 'text-gray-400 hover:text-red-400 hover:bg-white/5' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'}`}
            title="Remove"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3 mb-6">
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400 font-medium">CPU Load / RAM</span>
          <span className={`font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {telemetry && telemetry.cpu && telemetry.ram ? `${telemetry.cpu}% / ${telemetry.ram}%` : '---'}
          </span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400 font-medium">Docker Status</span>
          {telemetry?.docker && telemetry.docker !== 'none' ? (
            <span className={`${darkMode ? 'text-blue-400' : 'text-blue-600'} font-mono font-bold text-[10px] uppercase`}>Installed</span>
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
          className={`w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-widest ${darkMode ? 'text-gray-400 bg-white/5 border-white/5 hover:bg-white/10' : 'text-gray-500 bg-gray-50 border-gray-100 hover:bg-gray-100'} rounded-lg px-3 py-2 transition-colors`}
        >
          <span>Monitoring</span>
          <span className="font-mono text-[10px]">{monitoringOpen ? 'Hide' : 'Show'}</span>
        </button>

        {monitoringOpen && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-3 border`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">CPU</span>
                <span className={`text-[10px] font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>{telemetry?.cpu ? `${telemetry.cpu}%` : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.cpu === 'number' ? p.cpu : null))} color="#2563eb" height={44} />
            </div>

            <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-3 border`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">RAM</span>
                <span className={`text-[10px] font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>{telemetry?.ram ? `${telemetry.ram}%` : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.ram === 'number' ? p.ram : null))} color="#10b981" height={44} />
            </div>

            <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-3 border`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">LOAD (1m)</span>
                <span className={`text-[10px] font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>{history.length && typeof history[history.length - 1]?.load1 === 'number' ? history[history.length - 1].load1!.toFixed(2) : '—'}</span>
              </div>
              <Sparkline values={history.map(p => (typeof p.load1 === 'number' ? p.load1 : null))} color="#f59e0b" height={44} />
            </div>

            <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-3 border`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">NET</span>
                <span className={`text-[10px] font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  {history.length && typeof history[history.length - 1]?.rxMb === 'number' && typeof history[history.length - 1]?.txMb === 'number'
                    ? `RX ${history[history.length - 1].rxMb!.toFixed(1)} / TX ${history[history.length - 1].txMb!.toFixed(1)}`
                    : '—'}
                </span>
              </div>
              <Sparkline values={history.map(p => (typeof p.txMb === 'number' ? p.txMb : null))} color="#a855f7" height={44} />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onTerminal}
          className="flex-1 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest h-10 rounded-lg bg-gray-50 border border-gray-100 hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-all text-gray-500 shadow-sm group"
        >
          <TerminalIcon className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
          Access Node
        </button>
        <button
          onClick={async () => {
            setProdTest({ running: true });
            try {
              const res = await fetch(`/api/servers/${server.id}/exec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command: [
                    'echo "=== PROD TEST ==="',
                    'uname -a',
                    'echo "Node.js:"; node -v || echo "Not installed"',
                    'echo "Docker:"; docker --version || echo "Not installed"',
                    'echo "K3s:"; k3s --version 2>/dev/null || echo "Not installed"',
                    'echo "Disk usage:"; df -h / | tail -1',
                    'echo "CPU info:"; nproc || echo "nproc not available"',
                    'echo "Memory:"; free -h || cat /proc/meminfo | grep Mem',
                  ].join(' && ')
                })
              });
              const data = await res.json();
              setProdTest({ running: false, result: data });
            } catch (e) {
              setProdTest({ running: false, result: { code: -1, output: '', error: String(e) } });
            }
          }}
          disabled={prodTest?.running}
          className={`flex-1 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest h-10 rounded-lg border transition-all shadow-sm ${prodTest?.running ? 'bg-emerald-50 border-emerald-100 text-emerald-600 cursor-wait' : 'bg-gray-50 border-gray-100 text-gray-500 hover:bg-emerald-600 hover:text-white hover:border-emerald-600'}`}
        >
          {prodTest?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
          {prodTest?.running ? 'Testing' : 'Prod Test'}
        </button>
        <button
          onClick={onSettings}
          className="w-10 h-10 flex items-center justify-center bg-gray-50 border border-gray-100 rounded-lg hover:border-gray-300 transition-colors"
          title="Server Settings"
        >
          <Settings className="w-4 h-4 text-gray-400" />
        </button>
        <button
          onClick={onNuke}
          className="w-10 h-10 flex items-center justify-center bg-red-50 border border-red-100 rounded-lg hover:bg-red-100 transition-colors"
          title="Nuke Server"
        >
          <Shield className="w-4 h-4 text-red-500" />
        </button>
      </div>
      {prodTest?.result && (
        <div className="mt-3 p-4 rounded-xl border border-emerald-200 bg-emerald-50/50 text-xs shadow-sm overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-emerald-700 font-bold uppercase tracking-wider text-[10px]">
              <Activity className="w-3 h-3" />
              Prod Test Result
            </div>
            <button
              onClick={() => setProdTest(null)}
              className="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 uppercase tracking-tight"
            >
              Hide
            </button>
          </div>

          <div className="flex items-center gap-2 mb-3 px-2 py-1 bg-white/50 border border-emerald-100 rounded-lg w-fit">
            <span className="text-emerald-600 font-bold">Status:</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${prodTest.result.code === 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
              {prodTest.result.code === 0 ? 'PASS' : 'FAIL'} (Code: {prodTest.result.code})
            </span>
          </div>

          {prodTest.result.output && (
            <div className="grid grid-cols-1 gap-2.5">
              {(() => {
                const lines = prodTest.result.output.split(/\r?\n/);
                const checks = [
                  { label: 'Kernel', key: 'uname', match: /^Linux|^Darwin/ },
                  { label: 'Node.js', key: 'Node.js', match: /^Node\.js:/ },
                  { label: 'Docker', key: 'Docker', match: /^Docker:/ },
                  { label: 'K3s', key: 'K3s', match: /^K3s:/ },
                  { label: 'Disk usage', key: 'Disk usage', match: /^Disk usage:/ },
                  { label: 'CPU info', key: 'CPU info', match: /^CPU info:/ },
                  { label: 'Memory', key: 'Memory', match: /^Memory:/ },
                ];
                const results: Record<string, string> = {};
                let lastKey = '';
                for (const line of lines) {
                  for (const check of checks) {
                    if (check.match.test(line)) {
                      lastKey = check.key;
                      results[lastKey] = line.replace(check.match, '').trim();
                    }
                  }
                  if (lastKey && !checks.some(c => c.match.test(line))) {
                    results[lastKey] += '\n' + line;
                  }
                }
                return checks.map(check => (
                  <div key={check.key} className="group/row flex flex-col gap-1 p-2 bg-white border border-emerald-100 rounded-lg hover:border-emerald-300 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-emerald-800 text-[10px] uppercase tracking-wide">{check.label}</span>
                      {results[check.key] ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                      ) : (
                        <AlertCircle className="w-3 h-3 text-amber-500" />
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-slate-600 truncate group-hover/row:whitespace-pre-wrap group-hover/row:break-all">
                      {results[check.key] || 'Not detected'}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}
          {prodTest.result.error && <div className="text-red-600 mt-2"><b>Error:</b> {prodTest.result.error}</div>}
        </div>
      )}
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
  autoRun: null | { kind: 'input'; label: string; command: string } | { kind: 'deploy'; label: string; scriptType: 'verify' | 'template'; templateConfig?: any };
  onClose: () => void;
}) {
  const [size, setSize] = useState({
    width: Math.min(window.innerWidth - 64, 1000),
    height: Math.min(window.innerHeight - 64, 700)
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragControls = useDragControls();

  useEffect(() => {
    const handleResize = () => {
      setSize(prev => ({
        width: Math.min(window.innerWidth - 64, prev.width),
        height: Math.min(window.innerHeight - 64, prev.height)
      }));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
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
            ws.current?.send(JSON.stringify({
              type: 'deploy',
              scriptType: autoRun.scriptType,
              ...(autoRun.scriptType === 'template' && (autoRun as any).templateConfig ? { templateConfig: (autoRun as any).templateConfig } : {})
            }));
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

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };


  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (e: MouseEvent) => {
      setSize(prev => ({
        width: Math.max(600, prev.width + e.movementX),
        height: Math.max(400, prev.height + e.movementY)
      }));
    };

    const onMouseUp = () => setIsResizing(false);

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/40 backdrop-blur-sm">
      <motion.div
        drag
        dragMomentum={false}
        dragControls={dragControls}
        dragListener={false}
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        style={{ width: size.width, height: size.height }}
        className="glass-terminal border border-white/10 rounded-2xl flex flex-col shadow-2xl overflow-hidden relative"
      >
        <div
          onPointerDown={(e) => dragControls.start(e)}
          className="h-14 border-b border-white/5 flex items-center justify-between px-6 bg-white/5 cursor-move"
        >
          <div className="flex items-center gap-4">
            <span className="text-[11px] font-mono text-gray-400">
              {server.username}@<span className="text-blue-400">{server.host}</span> &mdash; <span className="text-gray-100">{status}</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              <button
                onClick={() => handleDeploy('docker')}
                className="text-[10px] bg-slate-800 text-slate-100 border border-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors uppercase font-bold shadow-sm"
              >
                Install Docker
              </button>
              <button
                onClick={() => handleDeploy('k3s')}
                className="text-[10px] bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-500 transition-colors uppercase font-bold shadow-sm"
              >
                Bootstrap K3s
              </button>
              <button
                onClick={() => handleDeploy('full')}
                className="text-[10px] bg-sky-500 text-white px-3 py-1.5 rounded-lg hover:bg-sky-400 transition-colors uppercase font-bold shadow-sm"
              >
                Full Stack
              </button>
              <button
                onClick={() => handleDeploy('verify')}
                className="text-[10px] bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-500 transition-colors uppercase font-bold shadow-sm"
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
            <div key={i} dangerouslySetInnerHTML={{ __html: log.replace(/ /g, '&nbsp;') }} />
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

        {/* Resize Handle */}
        <div
          onMouseDown={startResizing}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize flex items-center justify-center group"
        >
          <div className="w-1.5 h-1.5 bg-white/20 rounded-full group-hover:bg-white/40 transition-colors" />
        </div>
      </motion.div>
    </div>
  );
}

function AppManagerView({
  servers,
  searchTerm,
  darkMode = false,
  onOpenTerminal,
  setIsTemplateModalOpen
}: {
  servers: Server[],
  searchTerm: string,
  darkMode?: boolean,
  onOpenTerminal: (server: Server, autoRun: any) => void,
  setIsTemplateModalOpen: (open: boolean) => void
}) {
  const [apps, setApps] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [_error, _setError] = useState<string | null>(null);

  const fetchApps = async () => {
    setLoading(true);
    _setError(null);
    try {
      const allApps: any[] = [];
      for (const s of servers) {
        try {
          const res = await fetch(`/api/servers/${s.id}/containers`);
          const data = await res.json();
          if (Array.isArray(data)) {
            allApps.push(...data.map(a => ({ ...a, serverId: s.id, serverName: s.name })));
          }
        } catch (e) {
          console.error(e);
        }
      }
      setApps(allApps);
    } catch (e) {
      _setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApps();
    const interval = setInterval(fetchApps, 10000);
    return () => clearInterval(interval);
  }, [servers]);

  const handleDelete = async (serverId: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/containers/${name}`, { method: 'DELETE' });
      if (res.ok) fetchApps();
    } catch (e) {
      alert('Failed to delete container');
    }
  };

  const handleOpenTerminal = (serverId: string, containerName: string, mode: 'shell' | 'logs') => {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    onOpenTerminal(server, mode === 'shell'
      ? { kind: 'input', label: `Exec: ${containerName}`, command: `sudo docker exec -it ${containerName} bash || sudo docker exec -it ${containerName} sh` }
      : { kind: 'input', label: `Logs: ${containerName}`, command: `sudo docker logs -f ${containerName}` }
    );
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className={`text-3xl font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>App Manager</h2>
          <p className="text-slate-500 font-medium mt-1">Fleet-wide container orchestration and monitoring</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsTemplateModalOpen(true)}
            className={`flex items-center gap-2 px-6 py-3 rounded-2xl text-sm font-bold transition-all shadow-lg ${darkMode ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-600/20' : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Deploy VPS Template
          </button>
          <button
            onClick={fetchApps}
            className={`p-3 border rounded-2xl transition-all shadow-sm group ${darkMode ? 'bg-white/5 border-white/5 hover:bg-white/10' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
            title="Refresh fleet"
          >
            <RefreshCw className={`w-5 h-5 text-slate-400 group-hover:text-blue-600 transition-colors ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {apps
          .filter(app =>
            app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            app.image.toLowerCase().includes(searchTerm.toLowerCase()) ||
            app.serverName.toLowerCase().includes(searchTerm.toLowerCase())
          )
          .length === 0 && !loading ? (
          <div className={`col-span-full py-20 text-center ${darkMode ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200'} border-2 border-dashed rounded-[2.5rem]`}>
            <div className={`w-16 h-16 ${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-2xl flex items-center justify-center mx-auto mb-4 border`}>
              <Box className={`w-8 h-8 ${darkMode ? 'text-gray-600' : 'text-slate-300'}`} />
            </div>
            <h3 className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>No active containers</h3>
            <p className="text-slate-500 max-w-xs mx-auto mt-2">Deploy your first app using the Quick Deploy button in the fleet view.</p>
          </div>
        ) : (
          apps
            .filter(app =>
              app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
              app.image.toLowerCase().includes(searchTerm.toLowerCase()) ||
              app.serverName.toLowerCase().includes(searchTerm.toLowerCase())
            )
            .map((app, i) => (
              <motion.div
                key={`${app.serverId}-${app.name}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-slate-200'} border rounded-[2.5rem] p-8 shadow-sm hover:shadow-xl hover:border-blue-500 transition-all group relative overflow-hidden`}
              >
                <div className="absolute top-0 right-0 p-8 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                </div>

                <div className="flex items-center gap-4 mb-8">
                  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-colors ${app.status.includes('Up')
                      ? (darkMode ? 'bg-emerald-500/20 border-emerald-500/20 text-emerald-400' : 'bg-emerald-50 border-emerald-100 text-emerald-600')
                      : (darkMode ? 'bg-white/5 border-white/5 text-gray-600' : 'bg-slate-50 border-slate-100 text-slate-400')
                    }`}>
                    <Box className="w-7 h-7" />
                  </div>
                  <div>
                    <h3 className={`text-xl font-bold truncate max-w-[180px] ${darkMode ? 'text-white' : 'text-slate-900'}`}>{app.name}</h3>
                    <div className="flex items-center gap-1.5 text-slate-400 text-xs font-bold uppercase tracking-widest mt-1">
                      <ServerIcon className="w-3 h-3" />
                      {app.serverName}
                    </div>
                  </div>
                </div>

                <div className="space-y-5 mb-8">
                  <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50/50 border-slate-100'} rounded-2xl p-4 border`}>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-1">Image Bundle</p>
                    <p className={`text-sm font-mono font-medium ${darkMode ? 'text-gray-300' : 'text-slate-700'} truncate`}>{app.image}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50/50 border-slate-100'} rounded-2xl p-4 border`}>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-1">Status</p>
                      <p className={`text-sm font-bold ${app.status.includes('Up') ? 'text-emerald-500' : 'text-amber-500'}`}>{app.status}</p>
                    </div>
                    <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50/50 border-slate-100'} rounded-2xl p-4 border`}>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-1">Endpoint</p>
                      <p className={`text-sm font-mono font-bold ${darkMode ? 'text-gray-300' : 'text-slate-700'}`}>{app.ports || 'internal'}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {app.ports && app.ports.includes('->') && (
                    <a
                      href={`http://${app.serverHost}:${app.ports.split('->')[0].split(':')[1] || app.ports.split('->')[0]}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20"
                    >
                      <ExternalLink className="w-4 h-4" /> Open App
                    </a>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleOpenTerminal(app.serverId, app.name, 'shell')}
                      className={`p-3 ${darkMode ? 'text-gray-400 hover:text-blue-400 hover:bg-white/5 border-white/5' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50 border-slate-100'} border rounded-xl transition-all`}
                      title="Container Shell"
                    >
                      <TerminalIcon className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => handleOpenTerminal(app.serverId, app.name, 'logs')}
                      className={`p-3 ${darkMode ? 'text-gray-400 hover:text-indigo-400 hover:bg-white/5 border-white/5' : 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 border-slate-100'} border rounded-xl transition-all`}
                      title="Container Logs"
                    >
                      <FileText className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => handleDelete(app.serverId, app.name)}
                      className={`p-3 ${darkMode ? 'text-gray-500 hover:text-red-400 hover:bg-white/5 border-white/5' : 'text-slate-400 hover:text-red-600 hover:bg-red-50 border-slate-100'} border rounded-xl transition-all`}
                      title="Remove Container"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))
        )}
      </div>
    </div>
  );
}

function QuickDeployModal({
  servers,
  selectedServerId,
  onChangeSelected,
  onStart,
  onClose,
  darkMode = false,
}: {
  servers: Server[];
  selectedServerId: string;
  onChangeSelected: (id: string) => void;
  onStart: () => void;
  onClose: () => void;
  darkMode?: boolean;
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
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-7 shadow-2xl`}
      >
        <div className={`flex items-center justify-between mb-5 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-4`}>
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
            className={`w-full border rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all ${darkMode ? 'bg-white/5 border-white/5 text-white' : 'bg-gray-50 border-gray-100 text-gray-900'}`}
          >
            {servers.map(s => (
              <option key={s.id} value={s.id} className={darkMode ? 'bg-gray-900 text-white' : ''}>
                {s.name} ({s.username}@{s.host})
              </option>
            ))}
          </select>
        </div>

        <div className="pt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className={`flex-1 py-3 px-4 rounded-xl border font-bold transition-all ${darkMode ? 'border-white/5 bg-white/5 hover:bg-white/10 text-gray-400' : 'border-gray-100 bg-gray-50 hover:bg-gray-100 text-gray-600'}`}
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



function Sparkline({
  values,
  color,
  height = 80,
}: {
  values: Array<number | null>;
  color: string;
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
  darkMode = false,
}: {
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
  darkMode?: boolean;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-7 shadow-2xl`}>
        <div className={`flex items-center justify-between mb-4 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-4`}>
          <div className="font-bold">{title}</div>
          <button onClick={onClose} className={`text-gray-400 ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'} transition-colors`}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{body}</p>
        <div className="pt-6 flex justify-end">
          <button onClick={onPrimary} className="py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20">
            {primaryLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TrafficModal({
  history,
  onClose,
  darkMode = false
}: {
  history: Record<string, Array<{ ts: number; rxMb?: number; txMb?: number }>>;
  onClose: () => void;
  darkMode?: boolean;
}) {
  const currentTotalRx = Object.values(history).reduce((acc, srvHist) => {
    const last = srvHist[srvHist.length - 1];
    return acc + (last?.rxMb || 0);
  }, 0);

  const currentTotalTx = Object.values(history).reduce((acc, srvHist) => {
    const last = srvHist[srvHist.length - 1];
    return acc + (last?.txMb || 0);
  }, 0);

  const maxLen = Math.max(0, ...Object.values(history).map(h => h.length));

  if (maxLen === 0) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm">
        <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-10 text-center shadow-2xl`}>
          <div className={`w-16 h-16 ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'} rounded-full flex items-center justify-center mx-auto mb-6`}>
            <Activity className="w-8 h-8 text-blue-500 animate-pulse" />
          </div>
          <h3 className="text-xl font-bold mb-2">No Traffic History</h3>
          <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'} text-sm mb-8 leading-relaxed`}>
            Traffic charts are populated from telemetry data. Connect your hosts and wait for the first sync (30s) to see real-time RX/TX totals across your fleet.
          </p>
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition-all">
            Got it
          </button>
        </motion.div>
      </motion.div>
    );
  }

  const rxSeries = [];
  const txSeries = [];
  for (let i = 0; i < maxLen; i++) {
    let rxSum = 0;
    let txSum = 0;
    for (const srvHist of Object.values(history)) {
      const idx = srvHist.length - maxLen + i;
      if (idx >= 0 && idx < srvHist.length) {
        rxSum += (srvHist[idx].rxMb || 0);
        txSum += (srvHist[idx].txMb || 0);
      }
    }
    rxSeries.push(rxSum);
    txSeries.push(txSum);
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-gray-900/30 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-2xl p-7 shadow-2xl`}>
        <div className={`flex items-center justify-between mb-4 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-4`}>
          <div className="font-bold">Fleet Traffic Overview</div>
          <button onClick={onClose} className={`text-gray-400 ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'} transition-colors`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'} mb-6 px-1`}>Visualizing aggregate network throughput across {Object.keys(history).length} active nodes.</p>

        <div className="grid grid-cols-2 gap-6 mt-6">
          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-4 border`}>
            <div className="flex justify-between items-center mb-2">
              <span className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total RX</span>
              <span className="text-lg font-mono font-bold text-blue-500">{currentTotalRx.toFixed(1)} MB</span>
            </div>
            <Sparkline values={rxSeries} color="#3b82f6" height={60} />
          </div>
          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'} rounded-xl p-4 border`}>
            <div className="flex justify-between items-center mb-2">
              <span className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total TX</span>
              <span className="text-lg font-mono font-bold text-purple-500">{currentTotalTx.toFixed(1)} MB</span>
            </div>
            <Sparkline values={txSeries} color="#a855f7" height={60} />
          </div>
        </div>

        <div className="pt-6 flex justify-end">
          <button onClick={onClose} className="py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20">
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ServerSettingsModal({
  server,
  maintenanceMode,
  darkMode = false,
  onClose,
  onOpenShell,
  onQuickDeploy,
  onVerify,
  onAnalyzeLogs,
  onNuke,
  onDeployDocker,
}: {
  server: Server;
  maintenanceMode: boolean;
  darkMode?: boolean;
  onClose: () => void;
  onOpenShell: () => void;
  onQuickDeploy: () => void;
  onVerify: () => void;
  onAnalyzeLogs: () => void;
  onNuke: () => void;
  onDeployDocker: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-gray-900/40 backdrop-blur-sm">
      <motion.div
        initial={{ y: 2, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 2, opacity: 0 }}
        transition={{ type: "tween", ease: "easeOut", duration: 0.15 }}
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-7 shadow-2xl`}
      >
        <div className={`flex items-center justify-between mb-4 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-4`}>
          <div>
            <div className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>{server.name}</div>
            <div className="text-[11px] text-gray-500 font-mono">{server.username}@{server.host}</div>
          </div>
          <button onClick={onClose} className={`text-gray-400 ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'} transition-colors`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onOpenShell} className={`py-3 px-4 rounded-xl border font-bold text-sm transition-all ${darkMode ? 'border-white/5 bg-white/5 hover:bg-white/10 text-white' : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-900'}`}>
            Open Shell
          </button>
          <button onClick={onVerify} className={`py-3 px-4 rounded-xl border font-bold text-sm transition-all ${darkMode ? 'border-white/5 bg-white/5 hover:bg-white/10 text-white' : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-900'}`}>
            Verify Stack
          </button>
          <button
            onClick={onQuickDeploy}
            disabled={maintenanceMode}
            className={`py-3 px-4 rounded-xl font-bold text-sm transition-all ${maintenanceMode ? (darkMode ? 'bg-white/5 text-gray-600' : 'bg-gray-200 text-gray-400') + ' cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/20'}`}
          >
            Quick Deploy
          </button>
          <button onClick={onAnalyzeLogs} className={`py-3 px-4 rounded-xl border font-bold text-sm transition-all ${darkMode ? 'border-white/5 bg-white/5 hover:bg-white/10 text-white' : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-900'}`}>
            Analyze Logs
          </button>
          <button
            onClick={onDeployDocker}
            className={`py-3 px-4 rounded-xl border font-bold text-sm flex items-center justify-center gap-2 transition-all ${darkMode ? 'border-blue-500/20 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400' : 'border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700'}`}
          >
            <Box className="w-4 h-4" /> Custom App
          </button>
          <button
            onClick={onNuke}
            className={`py-3 px-4 rounded-xl border-2 font-bold text-sm flex items-center justify-center gap-2 col-span-2 transition-all ${darkMode ? 'border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400' : 'border-red-100 bg-red-50 hover:bg-red-100 text-red-600'}`}
          >
            <Shield className="w-4 h-4" /> Nuke Server
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AddModal({ onAdd, darkMode = false, onClose }: { onAdd: (s: any) => void, darkMode?: boolean, onClose: () => void }) {
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    username: 'root',
    port: 22,
    password: '',
    privateKey: ''
  });
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [keyFileName, setKeyFileName] = useState('');

  const handleKeyFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKeyFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setFormData({ ...formData, privateKey: content });
    };
    reader.readAsText(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const submission = { ...formData };
    if (authType === 'password') submission.privateKey = '';
    else submission.password = '';
    onAdd(submission);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/20 backdrop-blur-sm"
    >
      <motion.div
        initial={{ y: 4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 4, opacity: 0 }}
        transition={{ type: "tween", ease: "easeOut", duration: 0.15 }}
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-8 shadow-2xl`}
      >
        <div className={`flex items-center justify-between mb-8 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-6`}>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Connect New Infrastructure</h2>
            <p className="text-sm text-gray-500 font-medium">Securely link a remote host via SSH.</p>
          </div>
          <button onClick={onClose} className={`text-gray-400 ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'} transition-colors`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Node Name"
              value={formData.name}
              darkMode={darkMode}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Frankfurt-Node-01"
              required
            />
            <Input
              label="Public IP / Host"
              value={formData.host}
              darkMode={darkMode}
              onChange={e => setFormData({ ...formData, host: e.target.value })}
              placeholder="10.0.x.x or nodes.io"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="SSH User"
              value={formData.username}
              darkMode={darkMode}
              onChange={e => setFormData({ ...formData, username: e.target.value })}
              required
            />
            <Input
              label="SSH Port"
              type="number"
              value={formData.port.toString()}
              darkMode={darkMode}
              onChange={e => setFormData({ ...formData, port: parseInt(e.target.value) })}
              required
            />
          </div>

          <div className="space-y-3">
            <div className="flex p-1 bg-white/5 border border-white/5 rounded-xl">
              <button
                type="button"
                onClick={() => setAuthType('password')}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${authType === 'password' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Password
              </button>
              <button
                type="button"
                onClick={() => setAuthType('key')}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${authType === 'key' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
              >
                SSH Key File
              </button>
            </div>

            {authType === 'password' ? (
              <Input
                label="Root Password"
                type="password"
                value={formData.password}
                darkMode={darkMode}
                onChange={e => setFormData({ ...formData, password: e.target.value })}
                placeholder="Password for auth"
                required
              />
            ) : (
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-gray-400 tracking-wider ml-1">Private Key File</label>
                <div className={`relative border-2 border-dashed rounded-xl p-4 transition-all ${formData.privateKey ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/10 hover:border-white/20 bg-white/5'
                  }`}>
                  <input
                    type="file"
                    onChange={handleKeyFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    required={!formData.privateKey}
                  />
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${formData.privateKey ? 'bg-blue-500 text-white' : 'bg-white/5 text-gray-500'}`}>
                      <FileText className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <p className={`text-sm font-bold ${formData.privateKey ? 'text-white' : 'text-gray-400'}`}>
                        {keyFileName || 'Select .pem or .key file'}
                      </p>
                      <p className="text-[10px] text-gray-500 font-medium">RSA, ED25519 supported</p>
                    </div>
                    {formData.privateKey && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className={`flex-1 py-3 px-4 rounded-xl border font-bold transition-all ${darkMode ? 'border-white/5 bg-white/5 hover:bg-white/10 text-gray-400' : 'border-gray-100 bg-gray-50 hover:bg-gray-100 text-gray-600'}`}
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

function Input({ label, darkMode = false, ...props }: { label: string, darkMode?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5 flex-1">
      <label className="text-[10px] uppercase font-bold text-gray-400 tracking-wider ml-1">{label}</label>
      <input
        {...props}
        className={`w-full ${darkMode ? 'bg-white/5 border-white/5 text-white placeholder:text-gray-600' : 'bg-gray-50 border-gray-100 text-gray-900 placeholder:text-gray-300'} border rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all`}
      />
    </div>
  );
}

function StorageNode({ server, darkMode = false }: { server: Server, darkMode?: boolean }) {
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
    <div className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-2xl p-6 shadow-sm hover:border-blue-500 transition-all`}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 ${darkMode ? 'bg-blue-600/20' : 'bg-blue-50'} rounded-lg`}>
            <Database className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <span className={`font-bold block text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>{server.name}</span>
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
            <span className={`${darkMode ? 'text-gray-300' : 'text-gray-900'} font-mono font-bold`}>{loading ? '---' : telemetry?.disk || 'Unknown'}</span>
          </div>
          <div className={`w-full ${darkMode ? 'bg-white/10' : 'bg-gray-100'} h-2.5 rounded-full overflow-hidden border ${darkMode ? 'border-white/5' : 'border-gray-100/50'}`}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${usagePercent}%` }}
              className={`h-full transition-all duration-1000 ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-amber-400' : 'bg-blue-600'
                }`}
            />
          </div>
        </div>

        <div className={`pt-4 flex items-center justify-between border-t ${darkMode ? 'border-white/5' : 'border-gray-50'} mt-2`}>
          <span className="text-[10px] text-gray-400 font-medium">Auto-scaling: <span className={`${darkMode ? 'text-gray-300' : 'text-gray-600'} font-bold italic`}>Manual Only</span></span>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('kubecast:analyze-logs', { detail: { serverId: server.id } }));
            }}
            className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
          >
            Analyze Log Bloat <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateClusterModal({ servers, onCreate, onClose, darkMode = false }: { servers: Server[], onCreate: (data: Partial<ClusterState>) => void, onClose: () => void, darkMode?: boolean }) {
  const [name, setName] = useState('');
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    onCreate({ name, serverIds: selectedServerIds });
  };

  const toggleServer = (id: string) => {
    setSelectedServerIds(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
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
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-2xl w-full max-w-lg p-8 shadow-2xl`}
      >
        <div className={`flex items-center justify-between mb-8 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} pb-6`}>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Create K3s Cluster</h2>
            <p className="text-sm text-gray-500 font-medium">Group servers to form a cluster.</p>
          </div>
          <button onClick={onClose} className={`text-gray-400 ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'} transition-colors`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Input
            label="Cluster Name"
            value={name}
            darkMode={darkMode}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Production Cluster"
            required
          />

          <div className="space-y-1.5 flex-1">
            <label className="text-[10px] uppercase font-bold text-gray-400 tracking-wider ml-1">Select Nodes</label>
            <div className={`max-h-48 overflow-y-auto border ${darkMode ? 'border-white/5 bg-white/5' : 'border-gray-100 bg-gray-50'} rounded-xl p-2`}>
              {servers.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-4">No servers available. Add hosts first.</div>
              ) : (
                servers.map(s => (
                  <label key={s.id} className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${darkMode ? 'hover:bg-white/5' : 'hover:bg-gray-100'}`}>
                    <input
                      type="checkbox"
                      checked={selectedServerIds.includes(s.id)}
                      onChange={() => toggleServer(s.id)}
                      className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 bg-transparent border-gray-300"
                    />
                    <div>
                      <div className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-gray-900'}`}>{s.name}</div>
                      <div className="text-xs text-gray-400">{s.host}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>

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
              disabled={!name}
              className="flex-1 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create Cluster
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

function ProdSimulationOverlay({ cluster, darkMode: _darkMode = false, onClose }: { cluster: ClusterState, darkMode?: boolean, onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'topology' | 'logs' | 'metrics'>('topology');
  const [simulatedLoad, setSimulatedLoad] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setSimulatedLoad(prev => {
        const next = prev + (Math.random() * 10 - 5);
        return Math.max(10, Math.min(95, next));
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 md:p-12 bg-slate-950/90 backdrop-blur-md"
    >
      <motion.div
        initial={{ scale: 0.99, y: 4, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.99, y: 4, opacity: 0 }}
        transition={{ type: "tween", ease: "circOut", duration: 0.2 }}
        className="bg-slate-900 border border-white/10 rounded-[2.5rem] w-full max-w-6xl h-full max-h-[850px] flex flex-col shadow-[0_0_100px_rgba(0,0,0,0.5)] overflow-hidden text-slate-100"
      >
        {/* Header */}
        <div className="h-20 border-b border-white/5 flex items-center justify-between px-10 shrink-0 bg-white/5">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20">
                <Globe className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold tracking-tight">{cluster.name}</h2>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/80">Production Simulation Active</span>
                </div>
              </div>
            </div>

            <div className="h-8 w-px bg-white/10 mx-2" />

            <div className="flex gap-1 bg-slate-800/50 p-1 rounded-xl border border-white/5">
              {(['topology', 'logs', 'metrics'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${activeTab === tab ? 'bg-white/10 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center hover:bg-white/5 transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col p-10 gap-8">
          {activeTab === 'topology' && (
            <div className="flex-1 flex gap-8">
              {/* Left: Load Balancer / Ingress */}
              <div className="w-1/3 flex flex-col gap-6">
                <div className="bg-white/5 border border-white/10 rounded-[2rem] p-8 flex flex-col items-center justify-center text-center group hover:border-blue-500/30 transition-colors">
                  <div className="w-16 h-16 bg-blue-500/10 rounded-3xl flex items-center justify-center mb-6 border border-blue-500/20">
                    <Globe className="w-8 h-8 text-blue-400" />
                  </div>
                  <h3 className="font-bold text-lg mb-2">Ingress Controller</h3>
                  <p className="text-xs text-slate-500 mb-6 font-medium">Auto-scaling NGINX Ingress Proxying</p>
                  <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div
                      animate={{ width: `${simulatedLoad}%` }}
                      className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                    />
                  </div>
                  <div className="mt-2 text-[10px] font-mono text-slate-400">LOAD: {simulatedLoad.toFixed(1)}%</div>
                </div>

                <div className="flex-1 bg-white/5 border border-white/10 rounded-[2rem] p-8 overflow-hidden relative">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-bold uppercase tracking-widest text-xs text-slate-400">Traffic Flow</h3>
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping" />
                    </div>
                  </div>
                  <div className="space-y-4">
                    {[1, 2, 3, 4, 5].map(i => (
                      <div key={i} className="flex items-center gap-4">
                        <div className="w-2 h-2 rounded-full bg-blue-500/30" />
                        <div className="flex-1 h-px bg-gradient-to-r from-blue-500/50 to-transparent" />
                        <span className="text-[9px] font-mono text-slate-600">REQ_{Math.floor(Math.random() * 1000)} OK</span>
                      </div>
                    ))}
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent to-slate-900/50 pointer-events-none" />
                </div>
              </div>

              {/* Center: Cluster Nodes */}
              <div className="flex-1 flex flex-col">
                <div className="grid grid-cols-2 gap-6 h-full">
                  {cluster.serverIds.map((id, idx) => (
                    <div key={id} className="bg-white/5 border border-white/10 rounded-[2rem] p-8 flex flex-col justify-between hover:bg-white/[0.07] transition-all group">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-1">Worker Node 0{idx + 1}</div>
                          <div className="font-bold text-lg">{id.substring(0, 8)}</div>
                        </div>
                        <div className="w-8 h-8 bg-emerald-500/10 rounded-xl flex items-center justify-center border border-emerald-500/20 text-emerald-400">
                          <CheckCircle2 className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="space-y-6">
                        <div className="space-y-2">
                          <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                            <span>Pod Usage</span>
                            <span>{Math.floor(Math.random() * 20 + 40)}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500/50 w-[60%]" />
                          </div>
                        </div>

                        <div className="flex gap-2">
                          {[1, 2, 3].map(p => (
                            <div key={p} className="flex-1 aspect-square bg-slate-800/50 rounded-xl flex items-center justify-center border border-white/5">
                              <Database className="w-4 h-4 text-slate-500" />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                  {cluster.serverIds.length < 4 && Array.from({ length: 4 - cluster.serverIds.length }).map((_, i) => (
                    <div key={i} className="bg-slate-950/30 border border-white/[0.02] border-dashed rounded-[2rem] flex items-center justify-center text-slate-800">
                      <Plus className="w-8 h-8 opacity-10" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="flex-1 bg-slate-950 border border-white/10 rounded-[2rem] p-8 font-mono text-sm overflow-y-auto terminal-scrollbar">
              <div className="text-emerald-500/50 mb-4 font-bold">--- INITIALIZING PRODUCTION SIMULATION LOGS ---</div>
              {[...Array(20)].map((_, i) => (
                <div key={i} className="mb-2 flex gap-4 text-xs">
                  <span className="text-slate-600">[{new Date().toLocaleTimeString()}]</span>
                  <span className="text-blue-400 font-bold uppercase tracking-tighter w-12 shrink-0">info</span>
                  <span className="text-slate-300">Cluster {cluster.name} scaled to {(Math.random() * 10).toFixed(0)} pods. Ingress health check passed.</span>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'metrics' && (
            <div className="flex-1 grid grid-cols-3 gap-6">
              <div className="bg-white/5 border border-white/10 rounded-[2rem] p-8 flex flex-col justify-between">
                <h4 className="font-bold text-xs uppercase tracking-widest text-slate-500">Request Rate</h4>
                <div className="flex-1 flex items-end gap-1 mb-6">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div key={i} className="flex-1 bg-blue-500/20 rounded-t-sm border-t border-blue-500/50" style={{ height: `${Math.random() * 60 + 20}%` }} />
                  ))}
                </div>
                <div className="text-4xl font-light">{(Math.random() * 100 + 400).toFixed(0)}<span className="text-sm text-slate-500 ml-2">req/s</span></div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-[2rem] p-8 flex flex-col justify-between">
                <h4 className="font-bold text-xs uppercase tracking-widest text-slate-500">Latency (p99)</h4>
                <div className="flex-1 flex items-end gap-1 mb-6">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div key={i} className="flex-1 bg-purple-500/20 rounded-t-sm border-t border-purple-500/50" style={{ height: `${Math.random() * 30 + 10}%` }} />
                  ))}
                </div>
                <div className="text-4xl font-light">{(Math.random() * 5 + 12).toFixed(1)}<span className="text-sm text-slate-500 ml-2">ms</span></div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-[2rem] p-8 flex flex-col justify-between">
                <h4 className="font-bold text-xs uppercase tracking-widest text-slate-500">Error Rate</h4>
                <div className="flex-1 flex items-center justify-center mb-6">
                  <div className="text-6xl font-black text-emerald-500 opacity-20">0.0%</div>
                </div>
                <div className="text-4xl font-light text-emerald-400">0.00<span className="text-sm text-emerald-500/50 ml-2">errors</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-20 border-t border-white/5 flex items-center justify-between px-10 shrink-0 bg-white/5">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Endpoint: api.kubecast.cloud</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Region: us-east-1 (Global)</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold hover:bg-white/10 transition-colors uppercase tracking-widest">
              Export Report
            </button>
            <button
              onClick={onClose}
              className="px-6 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-all uppercase tracking-widest shadow-lg shadow-blue-600/20"
            >
              Terminate Simulation
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
function NuclearWarningModal({ server, darkMode = false, onConfirm, onClose }: { server: Server, darkMode?: boolean, onConfirm: () => void, onClose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-gray-900/40 backdrop-blur-sm">
      <motion.div
        initial={{ y: 4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 4, opacity: 0 }}
        transition={{ type: "tween", ease: "easeOut", duration: 0.15 }}
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-[2rem] w-full max-w-md p-10 shadow-2xl text-center`}
      >
        <div className={`w-16 h-16 ${darkMode ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-100'} rounded-2xl flex items-center justify-center mx-auto mb-6 border`}>
          <AlertCircle className="w-8 h-8 text-amber-500" />
        </div>
        <h2 className="text-xl font-bold mb-2 uppercase tracking-tight">Destructive Action</h2>
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'} mb-8 leading-relaxed`}>
          You are about to enter the <span className="text-red-500 font-bold">Nuclear Protocol</span> for <b>{server.name}</b>. This will permanently uninstall all cluster components.
        </p>
        <div className="flex gap-3">
          <button onClick={onClose} className={`flex-1 py-3 font-bold ${darkMode ? 'text-gray-400 hover:text-white hover:bg-white/5' : 'text-gray-500 hover:bg-gray-50'} rounded-xl transition-all`}>Cancel</button>
          <button onClick={onConfirm} className={`flex-1 py-3 ${darkMode ? 'bg-white text-gray-900 hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-black'} font-bold rounded-xl transition-all`}>Continue</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function NuclearConfirmationModal({ server, isDestroying, darkMode = false, onConfirm, onClose }: { server: Server, isDestroying: boolean, darkMode?: boolean, onConfirm: () => void, onClose: () => void }) {
  const [typedHost, setTypedHost] = useState('');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={`fixed inset-0 z-[75] flex items-center justify-center p-8 ${darkMode ? 'bg-red-950/80' : 'bg-red-950/60'} backdrop-blur-md`}
    >
      <motion.div
        initial={{ scale: 0.99, y: 4, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.99, y: 4, opacity: 0 }}
        transition={{ type: "tween", ease: "circOut", duration: 0.2 }}
        className={`${darkMode ? 'bg-gray-900 border-red-500/20' : 'bg-white border-red-100'} border rounded-[2rem] w-full max-w-lg p-10 shadow-2xl relative overflow-hidden`}
      >
        <div className="absolute top-0 left-0 w-full h-2 bg-red-600 animate-pulse" />

        <div className="flex flex-col items-center text-center">
          <div className={`w-20 h-20 ${darkMode ? 'bg-red-500/10 border-red-500/20' : 'bg-red-100 border-red-50'} rounded-3xl flex items-center justify-center mb-8 border-4`}>
            <Shield className="w-10 h-10 text-red-600 animate-bounce" />
          </div>

          <h2 className={`text-2xl font-black ${darkMode ? 'text-white' : 'text-gray-900'} mb-2 uppercase tracking-tight`}>Final Authorization</h2>
          <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'} text-sm mb-8 leading-relaxed`}>
            This is the <span className="font-bold text-red-600 underline">LAST WARNING</span>. System wipe on <span className={`font-mono ${darkMode ? 'bg-white/10 text-white' : 'bg-gray-100 text-gray-800'} px-1.5 py-0.5 rounded`}>{server.host}</span> cannot be undone.
          </p>

          <div className="w-full space-y-4 mb-8">
            <div className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Type the host to confirm</div>
            <input
              value={typedHost}
              onChange={e => setTypedHost(e.target.value)}
              placeholder={server.host}
              className="w-full bg-red-50/50 border-2 border-red-100 rounded-xl px-4 py-4 text-center font-mono font-bold text-red-900 outline-none focus:border-red-600 transition-all placeholder:text-red-200 shadow-inner"
              autoFocus
            />
          </div>

          <div className="flex gap-3 w-full">
            <button
              onClick={onClose}
              disabled={isDestroying}
              className="flex-1 py-4 px-4 rounded-xl bg-gray-50 border border-gray-100 hover:bg-gray-100 text-gray-600 font-bold transition-all"
            >
              Abort
            </button>
            <button
              onClick={onConfirm}
              disabled={typedHost !== server.host || isDestroying}
              className={`flex-2 py-4 px-8 rounded-xl font-bold text-white transition-all shadow-lg shadow-red-600/20 ${typedHost === server.host && !isDestroying ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-200 cursor-not-allowed'}`}
            >
              {isDestroying ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Confirm Destruction'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

const DOCKER_TEMPLATES = {
  custom: "FROM ubuntu:latest\nCMD echo 'Hello World'\n",
  nginx: "FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n",
  nodejs: "FROM node:18-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nEXPOSE 3000\nCMD [\"node\", \"index.js\"]\n",
  python: "FROM python:3.10-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\nCOPY . .\nEXPOSE 8000\nCMD [\"python\", \"app.py\"]\n",
  nextcloud: "FROM nextcloud:apache\n# Disable initial example files (skeleton)\nRUN rm -rf /usr/src/nextcloud/core/skeleton/*\n",
};

function DeployDockerfileModal({ server, darkMode = false, onClose }: { server: Server, darkMode?: boolean, onClose: () => void }) {
  const [template, setTemplate] = useState<keyof typeof DOCKER_TEMPLATES>('custom');
  const [dockerfile, setDockerfile] = useState(DOCKER_TEMPLATES.custom);
  const [containerName, setContainerName] = useState('my-app');
  const [portMapping, setPortMapping] = useState('8080:80');
  const [status, setStatus] = useState<'idle' | 'deploying' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState('');

  const handleTemplateChange = (t: keyof typeof DOCKER_TEMPLATES) => {
    setTemplate(t);
    setDockerfile(DOCKER_TEMPLATES[t]);
    if (t === 'nginx') setPortMapping('8080:80');
    if (t === 'nodejs') setPortMapping('3000:3000');
    if (t === 'python') setPortMapping('8000:8000');
    if (t === 'nextcloud') {
      setPortMapping('8080:80');
      setContainerName('my-nextcloud');
    }
  };

  const handleStop = async () => {
    setStatus('deploying');
    setLogs('Stopping and removing ' + containerName + ' on ' + server.name + '...\n');
    try {
      const res = await fetch(`/api/servers/${server.id}/stop-container`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName })
      });
      const data = await res.json();
      if (res.ok && data.code === 0) {
        setStatus('success');
        setLogs(prev => prev + '\nSuccessfully removed container!\n' + data.output);
      } else {
        setStatus('error');
        setLogs(prev => prev + '\nFailed to remove container.\n' + data.error + '\n' + data.output);
      }
    } catch (e) {
      setStatus('error');
      setLogs(prev => prev + '\nNetwork Error: ' + String(e));
    }
  };

  const handleDeploy = async () => {
    setStatus('deploying');
    setLogs('Initiating Docker deployment on ' + server.name + '...\n');
    try {
      const res = await fetch(`/api/servers/${server.id}/deploy-dockerfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dockerfile, containerName, portMapping })
      });
      const data = await res.json();
      if (res.ok && data.code === 0) {
        setStatus('success');
        setLogs(prev => prev + '\nDeployment successful!\n' + data.output);
      } else {
        setStatus('error');
        setLogs(prev => prev + '\nDeployment failed.\n' + data.error + '\n' + data.output);
      }
    } catch (e) {
      setStatus('error');
      setLogs(prev => prev + '\nNetwork or API Error: ' + String(e));
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-gray-900/60 backdrop-blur-sm">
      <motion.div
        initial={{ y: 4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 4, opacity: 0 }}
        transition={{ type: "tween", ease: "easeOut", duration: 0.15 }}
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-[2rem] w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden m-4`}
      >
        <div className={`p-6 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} flex items-center justify-between shrink-0`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 ${darkMode ? 'bg-blue-600/20 border-blue-500/20 text-blue-400' : 'bg-blue-50 border-blue-100 text-blue-600'} rounded-xl flex items-center justify-center border`}>
              <Box className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight">Deploy Custom App</h2>
              <p className="text-xs text-gray-500 font-medium">Build and run a Dockerfile on <span className={`font-mono ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>{server.name}</span></p>
            </div>
          </div>
          <button onClick={onClose} className={`text-gray-400 transition-colors p-2 rounded-full ${darkMode ? 'hover:text-white hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100 hover:text-gray-900'}`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={`p-6 flex-1 overflow-y-auto space-y-6 ${darkMode ? 'bg-gray-900/50' : 'bg-gray-50/50'} terminal-scrollbar`}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1.5">Container Name</label>
              <input
                value={containerName}
                onChange={e => setContainerName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                className={`w-full border rounded-xl px-4 py-3 text-sm font-bold outline-none transition-all shadow-sm ${darkMode ? 'bg-white/5 border-white/5 focus:border-blue-500 text-white' : 'bg-white border-gray-200 focus:border-blue-500 text-gray-900'}`}
                placeholder="e.g. my-app"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1.5">Port Mapping (Host:Container)</label>
              <input
                value={portMapping}
                onChange={e => setPortMapping(e.target.value)}
                className={`w-full border rounded-xl px-4 py-3 text-sm font-mono outline-none transition-all shadow-sm ${darkMode ? 'bg-white/5 border-white/5 focus:border-blue-500 text-white' : 'bg-white border-gray-200 focus:border-blue-500 text-gray-900'}`}
                placeholder="e.g. 8080:80"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest">Dockerfile</label>
              <div className="flex gap-2">
                {(['custom', 'nginx', 'nodejs', 'python', 'nextcloud'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => handleTemplateChange(t)}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors border ${template === t
                        ? 'bg-blue-600 text-white border-blue-600'
                        : (darkMode ? 'bg-white/5 text-gray-400 border-white/5 hover:bg-white/10' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')
                      }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              value={dockerfile}
              onChange={e => setDockerfile(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-4 text-sm font-mono text-emerald-400 outline-none focus:ring-2 focus:ring-blue-500 shadow-inner h-64 resize-y"
              spellCheck={false}
            />
          </div>

          {logs && (
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1.5">Deployment Logs</label>
              <div className="bg-black rounded-xl p-4 text-[11px] font-mono text-gray-300 h-48 overflow-y-auto border border-gray-800 shadow-inner whitespace-pre-wrap">
                {logs}
              </div>
            </div>
          )}
        </div>

        <div className={`p-6 border-t flex gap-3 justify-between items-center shrink-0 ${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-100'}`}>
          <button
            onClick={handleStop}
            disabled={status === 'deploying'}
            className={`px-4 py-3 rounded-xl font-bold transition-all disabled:opacity-50 flex items-center gap-2 text-sm ${darkMode ? 'text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20' : 'text-red-600 hover:bg-red-50 border border-transparent hover:border-red-100'}`}
          >
            <Trash2 className="w-4 h-4" /> Stop & Remove App
          </button>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className={`px-6 py-3 rounded-xl font-bold transition-colors ${darkMode ? 'text-gray-400 hover:bg-white/5' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {status === 'success' ? 'Done' : 'Cancel'}
            </button>
            <button
              onClick={handleDeploy}
              disabled={status === 'deploying'}
              className="px-8 py-3 rounded-xl font-bold text-white transition-all shadow-lg bg-blue-600 hover:bg-blue-700 shadow-blue-600/20 disabled:bg-gray-400 flex items-center gap-2"
            >
              {status === 'deploying' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
              {status === 'deploying' ? 'Deploying...' : status === 'error' ? 'Retry Deploy' : 'Deploy Container'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function DeployTemplateModal({ servers, darkMode = false, onClose, onStart }: { servers: Server[], darkMode?: boolean, onClose: () => void, onStart: (server: Server, config: any) => void }) {
  const [config, setConfig] = useState<any>(null);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/template/config/defaults')
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        setLoading(false);
      });
    if (servers.length > 0) setSelectedServerId(servers[0].id);
  }, []);

  if (loading || !config) return null;

  const handleProfileToggle = (p: string) => {
    const profiles = config.profiles.includes(p)
      ? config.profiles.filter((x: string) => x !== p)
      : [...config.profiles, p];
    setConfig({ ...config, profiles });
  };

  const handleDeploy = () => {
    const server = servers.find(s => s.id === selectedServerId);
    if (!server) return;
    onStart(server, config);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-gray-900/40 backdrop-blur-md"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className={`${darkMode ? 'bg-gray-900 border-white/5 text-white' : 'bg-white border-gray-200 text-gray-900'} border rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden`}
      >
        <div className={`p-8 border-b ${darkMode ? 'border-white/5' : 'border-gray-100'} flex items-center justify-between`}>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30">
              <LayoutGrid className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-black tracking-tight">Deploy VPS Template</h2>
              <p className="text-sm text-gray-500 font-medium">Full Docker Compose stack with Traefik & Authelia</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="p-8 space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <label className="text-[10px] uppercase font-bold text-gray-400 tracking-widest ml-1">Target Host</label>
              <select
                value={selectedServerId}
                onChange={e => setSelectedServerId(e.target.value)}
                className={`w-full px-4 py-3 rounded-2xl border text-sm font-bold outline-none transition-all ${darkMode ? 'bg-white/5 border-white/5 text-white focus:border-blue-500' : 'bg-gray-50 border-gray-100 focus:border-blue-500'
                  }`}
              >
                {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
              </select>

              <Input
                label="Primary Domain"
                value={config.domain}
                darkMode={darkMode}
                onChange={e => setConfig({ ...config, domain: e.target.value })}
                placeholder="e.g. apps.yourdomain.com"
              />
              <Input
                label="SSL Email (ACME)"
                value={config.email}
                darkMode={darkMode}
                onChange={e => setConfig({ ...config, email: e.target.value })}
                placeholder="admin@yourdomain.com"
              />
              <Input
                label="Cloudflare API Token"
                value={config.cloudflare?.apiToken || ''}
                darkMode={darkMode}
                onChange={e => setConfig({
                  ...config,
                  cloudflare: { ...(config.cloudflare || { zoneId: '' }), apiToken: e.target.value }
                })}
                placeholder="Your Cloudflare API Token"
                type="password"
              />
              <Input
                label="Cloudflare Zone ID"
                value={config.cloudflare?.zoneId || ''}
                darkMode={darkMode}
                onChange={e => setConfig({
                  ...config,
                  cloudflare: { ...(config.cloudflare || { apiToken: '' }), zoneId: e.target.value }
                })}
                placeholder="Your Cloudflare Zone ID"
              />
            </div>

            <div className="space-y-4">
              <label className="text-[10px] uppercase font-bold text-gray-400 tracking-widest ml-1">Available Profiles</label>
              <div className="grid grid-cols-1 gap-2 max-h-[180px] overflow-y-auto pr-2 terminal-scrollbar">
                {['required', 'aiostreams', 'vaultwarden', 'nextcloud', 'plex', 'monitoring'].map(p => (
                  <button
                    key={p}
                    onClick={() => handleProfileToggle(p)}
                    disabled={p === 'required'}
                    className={`px-4 py-3 rounded-xl text-xs font-bold text-left transition-all flex items-center justify-between border ${config.profiles.includes(p)
                        ? (darkMode ? 'bg-blue-600/20 border-blue-500 text-blue-400' : 'bg-blue-50 border-blue-600 text-blue-700')
                        : (darkMode ? 'bg-white/5 border-white/5 text-gray-400' : 'bg-gray-50 border-gray-100 text-gray-500')
                      }`}
                  >
                    <span>{p.toUpperCase()}</span>
                    {config.profiles.includes(p) && <CheckCircle2 className="w-4 h-4" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <Shield className="w-6 h-6 text-amber-500 shrink-0" />
            <p className="text-[11px] text-amber-600 font-medium leading-relaxed">
              Secrets for <span className="font-black">Authelia JWT</span> and <span className="font-black">Session</span> have been automatically generated for security.
            </p>
          </div>

          <button
            onClick={handleDeploy}
            className="w-full py-5 rounded-2xl bg-blue-600 text-white font-black text-sm hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/30 flex items-center justify-center gap-2"
          >
            <Play className="w-4 h-4 fill-current" />
            Initialize VPS Stack
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MonitoringView({
  servers,
  telemetryByServerId,
  telemetryHistory,
  darkMode = false
}: {
  servers: Server[],
  telemetryByServerId: Record<string, any>,
  telemetryHistory: Record<string, Array<{ ts: number; cpu?: number; ram?: number; load1?: number; rxMb?: number; txMb?: number }>>,
  darkMode?: boolean
}) {
  const [filter, setFilter] = useState('');
  
  const filteredServers = servers.filter(s => 
    s.name.toLowerCase().includes(filter.toLowerCase()) || 
    s.host.toLowerCase().includes(filter.toLowerCase())
  );

  // Compute aggregate stats
  const activeServers = servers.filter(s => telemetryHistory[s.id]?.length > 0);
  const avgCpu = activeServers.length 
    ? (activeServers.reduce((acc, s) => acc + (telemetryHistory[s.id]?.slice(-1)[0]?.cpu || 0), 0) / activeServers.length).toFixed(1)
    : '0';
  const avgRam = activeServers.length
    ? (activeServers.reduce((acc, s) => acc + (telemetryHistory[s.id]?.slice(-1)[0]?.ram || 0), 0) / activeServers.length).toFixed(1)
    : '0';

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 h-full overflow-y-auto pr-2 pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className={`text-3xl font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>Fleet Intelligence</h2>
          <p className="text-slate-500 font-medium mt-1">Real-time system telemetry and resource utilization</p>
        </div>
        <div className="flex items-center gap-3">
           <div className={`relative flex-1 md:w-64 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-50" />
            <input
              type="text"
              placeholder="Filter fleet..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className={`w-full pl-10 pr-4 py-2.5 rounded-xl border text-sm font-medium transition-all outline-none ${
                darkMode 
                  ? 'bg-white/5 border-white/5 focus:bg-white/10 focus:border-blue-500/50' 
                  : 'bg-white border-slate-200 focus:border-blue-500 focus:shadow-lg focus:shadow-blue-500/5'
              }`}
            />
          </div>
        </div>
      </div>

      {/* Aggregate Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatSummaryCard
          icon={<Cpu className="w-5 h-5" />}
          label="Avg CPU Load"
          value={`${avgCpu}%`}
          color="blue"
          darkMode={darkMode}
        />
        <StatSummaryCard
          icon={<Zap className="w-5 h-5" />}
          label="Avg Memory"
          value={`${avgRam}%`}
          color="emerald"
          darkMode={darkMode}
        />
        <StatSummaryCard
          icon={<Network className="w-5 h-5" />}
          label="Active Nodes"
          value={activeServers.length.toString()}
          color="purple"
          darkMode={darkMode}
        />
        <StatSummaryCard
          icon={<Database className="w-5 h-5" />}
          label="Total Servers"
          value={servers.length.toString()}
          color="amber"
          darkMode={darkMode}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 pb-20">
        {filteredServers.map(server => (
          <MonitoringServerCard
            key={server.id}
            server={{ ...server, telemetry: telemetryByServerId[server.id] }}
            history={telemetryHistory[server.id] || []}
            darkMode={darkMode}
          />
        ))}
      </div>
    </div>
  );
}

function StatSummaryCard({ icon, label, value, color, darkMode }: { icon: React.ReactNode, label: string, value: string, color: string, darkMode: boolean }) {
  const colorClasses: Record<string, string> = {
    blue: darkMode ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-blue-50 text-blue-600 border-blue-100',
    emerald: darkMode ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-emerald-50 text-emerald-600 border-emerald-100',
    purple: darkMode ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-purple-50 text-purple-600 border-purple-100',
    amber: darkMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-amber-50 text-amber-600 border-amber-100',
  };

  return (
    <div className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-2xl p-5 shadow-sm`}>
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2.5 rounded-xl border ${colorClasses[color]}`}>
          {icon}
        </div>
        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">{label}</span>
      </div>
      <div className={`text-2xl font-black ${darkMode ? 'text-white' : 'text-slate-900'}`}>{value}</div>
    </div>
  );
}

function MonitoringServerCard({ server, history, darkMode }: { server: Server, history: any[], darkMode: boolean }) {
  const latest = history.slice(-1)[0] || {};
  
  return (
    <motion.div
      layout
      className={`${darkMode ? 'bg-gray-900 border-white/5' : 'bg-white border-gray-200'} border rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-blue-500/50 transition-all duration-300`}
    >
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-sm ${
            server.status === 'online' 
              ? (darkMode ? 'bg-blue-600/20 border-blue-500/20 text-blue-400' : 'bg-blue-50 border-blue-100 text-blue-600')
              : (darkMode ? 'bg-white/5 border-white/5 text-gray-600' : 'bg-gray-50 border-gray-100 text-gray-400')
          }`}>
            <ServerIcon className="w-6 h-6" />
          </div>
          <div>
            <h3 className={`text-lg font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>{server.name}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${server.status === 'online' ? 'bg-emerald-500' : 'bg-gray-300'} animate-pulse`} />
              <p className="text-xs text-gray-400 font-mono tracking-tight lowercase">{server.username}@{server.host}</p>
            </div>
          </div>
        </div>
        <div className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${
          server.status === 'online'
            ? (darkMode ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-emerald-50 text-emerald-600 border-emerald-100')
            : (darkMode ? 'bg-white/5 text-gray-500 border-white/5' : 'bg-gray-50 text-gray-400 border-gray-100')
        }`}>
          {server.status === 'online' ? 'Connected' : 'Offline'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* CPU & Load Section */}
        <div className="space-y-6">
          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-2xl p-5 border relative overflow-hidden`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Processor usage</span>
              </div>
              <span className={`text-xl font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                {latest.cpu !== undefined ? `${latest.cpu}%` : '--'}
              </span>
            </div>
            <div className="h-2 w-full bg-gray-200/50 rounded-full mb-4 overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${latest.cpu || 0}%` }}
                className="h-full bg-blue-500 rounded-full" 
              />
            </div>
            <Sparkline values={history.map(p => p.cpu || null)} color="#3b82f6" height={60} />
          </div>

          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-2xl p-5 border`}>
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-amber-500" />
              <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Load Averages</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <LoadBox label="1m" value={latest.load1} darkMode={darkMode} />
              <LoadBox label="5m" value={latest.load5 || latest.load1} darkMode={darkMode} />
              <LoadBox label="15m" value={latest.load15 || latest.load1} darkMode={darkMode} />
            </div>
          </div>
        </div>

        {/* Memory & Network Section */}
        <div className="space-y-6">
          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-2xl p-5 border`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Memory Pressure</span>
              </div>
              <span className={`text-xl font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                {latest.ram !== undefined ? `${latest.ram}%` : '--'}
              </span>
            </div>
            <div className="h-2 w-full bg-gray-200/50 rounded-full mb-4 overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${latest.ram || 0}%` }}
                className="h-full bg-emerald-500 rounded-full" 
              />
            </div>
            <Sparkline values={history.map(p => p.ram || null)} color="#10b981" height={60} />
          </div>

          <div className={`${darkMode ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-2xl p-5 border`}>
             <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Network className="w-4 h-4 text-purple-500" />
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Network Throughput</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <ArrowDown className="w-3 h-3 text-emerald-500" />
                  <span className="text-[10px] font-bold font-mono text-gray-500">{latest.rxMb?.toFixed(1) || '0.0'} MB/s</span>
                </div>
                <div className="flex items-center gap-1">
                  <ArrowUp className="w-3 h-3 text-blue-500" />
                  <span className="text-[10px] font-bold font-mono text-gray-500">{latest.txMb?.toFixed(1) || '0.0'} MB/s</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
               <div>
                 <span className="text-[9px] uppercase tracking-tighter text-gray-400 font-bold block mb-1">Upload</span>
                 <Sparkline values={history.map(p => p.txMb || null)} color="#3b82f6" height={40} />
               </div>
               <div>
                 <span className="text-[9px] uppercase tracking-tighter text-gray-400 font-bold block mb-1">Download</span>
                 <Sparkline values={history.map(p => p.rxMb || null)} color="#10b981" height={40} />
               </div>
            </div>
          </div>
        </div>
      </div>
      
      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
          <div className="flex items-center gap-2 mb-2">
            <HardDrive className="w-4 h-4 text-slate-400" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Primary Disk Usage</span>
          </div>
          <div className="flex items-end justify-between">
            <span className={`text-lg font-black ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              {server.telemetry?.disk || 'Checking...'}
            </span>
            <span className="text-[10px] text-gray-400 font-medium">Mount: /</span>
          </div>
        </div>
        
        <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
          <div className="flex items-center gap-2 mb-2">
             <Shield className="w-4 h-4 text-blue-400" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Docker Engine</span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[10px] font-black uppercase ${server.telemetry?.docker && server.telemetry.docker !== 'none' ? 'text-blue-500' : 'text-gray-400'}`}>
              {server.telemetry?.docker && server.telemetry.docker !== 'none' ? 'Operational' : 'Missing'}
            </span>
            <div className={`w-2 h-2 rounded-full ${server.telemetry?.docker && server.telemetry.docker !== 'none' ? 'bg-blue-500' : 'bg-gray-300'}`} />
          </div>
        </div>

        <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-white/5 border-white/5' : 'bg-gray-50 border-gray-100'}`}>
          <div className="flex items-center gap-2 mb-2">
             <RefreshCw className="w-4 h-4 text-emerald-400" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Telemetry Sync</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black text-emerald-500 uppercase">Live (10s)</span>
            <motion.div 
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ repeat: Infinity, duration: 2 }}
              className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" 
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function LoadBox({ label, value, darkMode }: { label: string, value: number | undefined, darkMode: boolean }) {
  return (
    <div className={`p-3 rounded-xl border flex flex-col items-center justify-center transition-colors ${
      darkMode ? 'bg-white/5 border-white/5' : 'bg-white border-slate-200'
    }`}>
      <span className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter mb-1">{label}</span>
      <span className={`text-sm font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>
        {value !== undefined ? value.toFixed(2) : '--'}
      </span>
    </div>
  );
}

