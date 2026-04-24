export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: 'online' | 'offline' | 'error';
  installed: {
    docker: boolean;
    k8s: boolean;
  };
}

export interface Cluster {
  id: string;
  name: string;
  serverIds: string[];
}
