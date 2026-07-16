const BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');

export interface MemberInfo {
  userId: string;
  pubkey: string;
  signPubkey: string;
  joinedAt?: string;
}

export interface AuthResponse {
  token: string;
  userId: string;
  pubkey: string;
  signPubkey: string;
  vaultSalt: string;
}

export interface ChannelSummary {
  channelId: string;
  code: string;
  codeExpiresAt: string | null;
  createdAt: string;
  joinedAt: string;
  memberCount: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError('cannot reach server', 0);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `request failed: ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (
    username: string,
    password: string,
    pubkey: string,
    signPubkey: string,
    vaultSalt: string
  ) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, pubkey, signPubkey, vaultSalt }),
    }),

  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: (token: string) =>
    request<Omit<AuthResponse, 'token'>>('/auth/me', {}, token),

  createChannel: (token: string) =>
    request<{ channelId: string; code: string; codeExpiresAt: string; members: MemberInfo[] }>(
      '/channel/create',
      { method: 'POST' },
      token
    ),

  joinChannel: (token: string, code: string) =>
    request<{ channelId: string; code: string; isNewMember: boolean; members: MemberInfo[] }>(
      '/channel/join',
      { method: 'POST', body: JSON.stringify({ code }) },
      token
    ),

  listChannels: (token: string) =>
    request<{ channels: ChannelSummary[] }>('/channel/list', {}, token),

  members: (token: string, channelId: string) =>
    request<{ members: MemberInfo[] }>(`/channel/${channelId}/members`, {}, token),

  rotateCode: (token: string, channelId: string) =>
    request<{ code: string; codeExpiresAt: string }>(
      `/channel/${channelId}/rotate-code`,
      { method: 'POST' },
      token
    ),

  leaveChannel: (token: string, channelId: string) =>
    request<{ ok: true }>(`/channel/${channelId}/leave`, { method: 'DELETE' }, token),

  wsUrl: () => {
    const url = new URL(BASE_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    return url.toString();
  },

  /**
   * The token rides in the WebSocket subprotocol, not the query string.
   * Query strings land in access logs, proxy logs, and browser history; a
   * subprotocol value does not.
   */
  wsProtocols: (token: string) => ['darkchat', `bearer.${token}`],
};
