export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  status: 'online' | 'offline' | 'error';
  installed: {
    docker: boolean;
    k8s: boolean;
  };
  telemetry?: {
    cpu?: string;
    ram?: string;
    disk?: string;
    docker?: string;
    k3s?: string;
  };
}

export interface Cluster {
  id: string;
  name: string;
  serverIds: string[];
}

// For frontend state
export type ClusterState = Cluster & { editing?: boolean };
