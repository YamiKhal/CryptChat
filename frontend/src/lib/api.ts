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

export interface UnfurlResponse {
  url: string;
  kind: 'link' | 'youtube' | 'image';
  title?: string;
  description?: string;
  siteName?: string;
  videoId?: string;
  /** Raw bytes proxied by the relay; the sender re-encodes before sending. */
  image?: { mime: string; data: string };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// The chunk size is server policy and fixed for the process lifetime.
let cachedChunkSize: number | null = null;

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

  /* --- encrypted blobs --- */

  blobInit: (
    token: string,
    body: { channelId: string; declaredBytes: number; declaredChunks: number }
  ) =>
    request<{ blobId: string; chunkBytes: number }>(
      '/blob/init',
      { method: 'POST', body: JSON.stringify(body) },
      token
    ),

  blobChunkSize: async (token: string) => {
    if (cachedChunkSize !== null) return cachedChunkSize;
    const res = await request<{ chunkBytes: number }>('/blob/config', {}, token);
    cachedChunkSize = res.chunkBytes;
    return cachedChunkSize;
  },

  /**
   * One ciphertext chunk. Raw bytes, not JSON -- base64 would add 33% to every
   * upload, and the server's JSON parser is capped far below a chunk anyway.
   */
  blobChunk: async (token: string, blobId: string, index: number, cipher: Uint8Array) => {
    const res = await fetch(`${BASE_URL}/blob/${blobId}/chunk`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Index': String(index),
        Authorization: `Bearer ${token}`,
      },
      body: cipher as unknown as BodyInit,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error || `chunk upload failed: ${res.status}`, res.status);
    }
    return res.json() as Promise<{ chunksReceived: number; bytesReceived: number }>;
  },

  blobStatus: (token: string, blobId: string) =>
    request<{ status: string; chunksReceived: number; declaredChunks: number }>(
      `/blob/${blobId}/status`,
      {},
      token
    ),

  blobFinish: (token: string, blobId: string) =>
    request<{ ok: true }>(`/blob/${blobId}/finish`, { method: 'POST' }, token),

  /** Returns the raw Response so the caller can stream and decrypt as it goes. */
  blobDownload: async (token: string, blobId: string) => {
    const res = await fetch(`${BASE_URL}/blob/${blobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error || `download failed: ${res.status}`, res.status);
    }
    return res;
  },

  /**
   * Ask the relay to fetch a URL's metadata.
   *
   * Only the sender ever calls this, and only when the user opted in. It is
   * the one place the server learns message content, which is why it is never
   * automatic.
   */
  unfurl: (token: string, url: string) =>
    request<UnfurlResponse>(`/unfurl?url=${encodeURIComponent(url)}`, {}, token),

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
