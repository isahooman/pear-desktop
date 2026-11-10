import {
  type BaseConnectionErrorType,
  type DataConnection,
  type DataConnectionErrorType,
  Peer,
  type PeerError,
  PeerErrorType,
} from 'peerjs';

import type { Permission, Profile, VideoData } from './types';

export type ConnectionEventMap = {
  CLEAR_QUEUE: null;
  // `replace` swaps out the whole queue (someone played a song)
  ADD_SONGS: { videoList: VideoData[]; index?: number; replace?: boolean };
  REMOVE_SONG: { index: number };
  MOVE_SONG: { fromIndex: number; toIndex: number };
  SET_INDEX: { index: number; videoId?: string; transitionId?: string };
  // a guest has loaded the song of a transition and is waiting to play
  TRANSITION_READY: { transitionId: string };
  // everyone may start playing the new song
  TRANSITION_GO: { transitionId?: string; progress: number };
  IDENTIFY: { profile: Profile } | undefined;
  SYNC_PROFILE: { profiles: Record<string, Profile> } | undefined;
  SYNC_QUEUE: { videoList: VideoData[] } | undefined;
  SYNC_PROGRESS:
    | {
        progress?: number;
        state?: number;
        index?: number;
        videoId?: string;
        queueHash?: string;
      }
    | undefined;
  PERMISSION: Permission | undefined;
  PING: { sentAt: number };
  PONG: { sentAt: number };
  CONNECTION_CLOSED: null;
};
export type ConnectionEventUnion = {
  [Event in keyof ConnectionEventMap]: {
    type: Event;
    payload: ConnectionEventMap[Event];
    after?: ConnectionEventUnion[];
  };
}[keyof ConnectionEventMap];

type PromiseUtil<T> = {
  promise: Promise<T>;
  resolve: (id: T) => void;
  reject: (err: unknown) => void;
};

export type ConnectionListener = (
  event: ConnectionEventUnion,
  conn: DataConnection | null,
) => void;
export type ConnectionMode = 'host' | 'guest' | 'disconnected';
export type RejoinState = 'rejoining' | 'rejoined';

const RECOVERABLE_PEER_ERRORS = new Set([
  PeerErrorType.Network,
  PeerErrorType.ServerError,
  PeerErrorType.SocketError,
  PeerErrorType.SocketClosed,
]);

const PING_INTERVAL = 5_000;
// Pings are sent more often right after joining, to settle the latency fast
const FAST_PING_INTERVAL = 2_000;
const FAST_PING_COUNT = 5;
// Latency is the best of the last few measurements, spikes aren't real latency
const LATENCY_SAMPLES = 10;
// The host drops guests it hasn't heard from (guests ping every few seconds)
const STALE_AFTER = 20_000;
const WATCHDOG_INTERVAL = 5_000;
// How long a guest keeps trying to get back to the host after a drop
const REJOIN_WINDOW = 20_000;
const REJOIN_ATTEMPT_TIMEOUT = 5_000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
  { urls: 'stun:freestun.net:3478' },
  { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Connection {
  private peer: Peer;
  private _mode: ConnectionMode = 'disconnected';
  private connections: Record<string, DataConnection> = {};
  private lastSeen: Record<string, number> = {};

  private isDestroyed = false;
  private isReconnecting = false;

  private pingTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private rttSamples: number[] = [];
  private _latency = 0;

  // guest only: the connection to the host, and what's needed to restore it
  private hostId?: string;
  private hostConn?: DataConnection;
  private rejoining = false;
  private rejoinListeners: ((state: RejoinState) => void)[] = [];

  private waitOpen: PromiseUtil<string> = {} as PromiseUtil<string>;
  private listeners: ConnectionListener[] = [];
  private connectionListeners: ((connection?: DataConnection) => void)[] = [];

  constructor(extraIceServers: RTCIceServer[] = []) {
    this.peer = new Peer({
      debug: 0,
      config: {
        iceServers: [...extraIceServers, ...DEFAULT_ICE_SERVERS],
        sdpSemantics: 'unified-plan',
      },
    });

    this.waitOpen.promise = new Promise<string>((resolve, reject) => {
      this.waitOpen.resolve = resolve;
      this.waitOpen.reject = reject;
    });

    this.peer.on('open', (id) => {
      if (this._mode === 'disconnected') this._mode = 'host';
      this.waitOpen.resolve(id);
    });

    this.peer.on('connection', async (conn) => {
      this._mode = 'host';
      this.startWatchdog();
      try {
        await this.registerConnection(conn);
      } catch {
        // ignore
      }
    });

    this.peer.on('disconnected', async () => {
      if (this.isDestroyed) return;
      console.warn('Music Together: lost server connection, reconnecting...');
      await this.reconnectLoop();
    });

    this.peer.on('close', () => this.cleanup());

    this.peer.on('error', async (err) => {
      if (!this.isDestroyed && RECOVERABLE_PEER_ERRORS.has(err.type)) {
        console.warn('Music Together: recoverable peer error', err.type);
        await this.reconnectLoop();
        return;
      }
      if (err.type === 'peer-unavailable') return;
      if (err.type === 'unavailable-id') {
        console.warn(
          'Music Together: id no longer available, staying on existing connections.',
        );
        this.isReconnecting = false;
        return;
      }

      console.error('Music Together: fatal peer error', err);
      this.waitOpen.reject(err);
      this.disconnect();
    });
  }

  /* public */
  async waitForReady() {
    return this.waitOpen.promise;
  }

  async connect(id: string) {
    this._mode = 'guest';
    const conn = this.peer.connect(id, {
      reliable: true,
    });

    const unavailable = new Promise<never>((_, reject) => {
      const onError = (err: PeerError<`${PeerErrorType}`>) => {
        if (err.type === 'peer-unavailable') {
          this.peer.off('error', onError);
          reject(err);
        }
      };
      this.peer.on('error', onError);
      conn.once('open', () => this.peer.off('error', onError));
      conn.once('close', () => this.peer.off('error', onError));
    });

    await Promise.race([this.registerConnection(conn), unavailable]);

    this.hostId = id;
    this.hostConn = conn;
    this.startPing();

    return conn;
  }

  disconnect() {
    if (this.isDestroyed) return;

    this.isDestroyed = true;
    this.isReconnecting = false;
    this.rejoining = false;
    this._mode = 'disconnected';

    this.getConnections().forEach((conn) =>
      conn.close({
        flush: true,
      }),
    );

    if (!this.peer.destroyed) this.peer.destroy();
    else this.cleanup();
  }

  /* utils */
  public get id() {
    return this.peer.id;
  }

  public get mode() {
    return this._mode;
  }

  /** Estimated one-way latency to the host in ms (guest only). */
  public get latency() {
    return this._latency;
  }

  /** Guest only: the connection to the host dropped and is being restored. */
  public get isRejoining() {
    return this.rejoining;
  }

  public getConnections() {
    return Object.values(this.connections);
  }

  public async broadcast<Event extends keyof ConnectionEventMap>(
    type: Event,
    payload: ConnectionEventMap[Event],
    after?: ConnectionEventUnion[],
  ) {
    await Promise.all(
      this.getConnections().map(
        (conn) => conn.send({ type, payload, after }) ?? Promise.resolve(),
      ),
    );
  }

  public on(listener: ConnectionListener) {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  public onConnections(listener: (connection?: DataConnection) => void) {
    this.connectionListeners.push(listener);
  }

  /** Guest only: called when the host is lost and again once it is back. */
  public onRejoin(listener: (state: RejoinState) => void) {
    this.rejoinListeners.push(listener);
  }

  /* privates */
  private async reconnectLoop() {
    if (this.isDestroyed || this.isReconnecting || this.peer.destroyed) return;
    this.isReconnecting = true;

    let attempt = 0;
    while (
      !this.isDestroyed &&
      this.peer.disconnected &&
      !this.peer.destroyed
    ) {
      attempt += 1;
      const factor = 2 ** (attempt - 1);
      const backoff = Math.min(30_000, 1_000 * factor);
      console.warn(`Music Together: reconnect attempt ${attempt}...`);
      try {
        this.peer.reconnect();
      } catch (err) {
        console.error('Music Together: reconnect() threw', err);
      }
      await sleep(backoff);
    }

    this.isReconnecting = false;
  }

  private startPing() {
    this.stopPing();
    let sent = 0;
    const tick = () => {
      if (this.hostConn?.open) {
        this.hostConn.send({
          type: 'PING',
          payload: { sentAt: performance.now() },
        });
      }
      sent += 1;
      this.pingTimer = setTimeout(
        tick,
        sent < FAST_PING_COUNT ? FAST_PING_INTERVAL : PING_INTERVAL,
      );
    };
    tick();
  }

  private stopPing() {
    clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Host only: close connections of guests that went silent. */
  private startWatchdog() {
    if (this.watchdog !== undefined) return;
    this.watchdog = setInterval(() => {
      const now = performance.now();
      for (const conn of this.getConnections()) {
        const seen = this.lastSeen[conn.connectionId] ?? now;
        if (now - seen > STALE_AFTER) {
          console.warn('Music Together: dropping silent guest', conn.peer);
          conn.close();
        }
      }
    }, WATCHDOG_INTERVAL);
  }

  /** Guest only: tries to get back to the host after the connection dropped. */
  private async rejoin(lost: DataConnection) {
    if (this.rejoining || !this.hostId) return;
    this.rejoining = true;
    this.stopPing();
    this.rttSamples = [];
    this.rejoinListeners.forEach((listener) => listener('rejoining'));

    const deadline = Date.now() + REJOIN_WINDOW;
    let attempt = 0;
    while (!this.isDestroyed && Date.now() < deadline) {
      attempt += 1;
      // the reconnect loop is bringing the signaling server connection back
      if (this.peer.disconnected) {
        await sleep(1_000);
        continue;
      }

      const conn = this.peer.connect(this.hostId, { reliable: true });
      try {
        await Promise.race([
          this.registerConnection(conn, false),
          sleep(REJOIN_ATTEMPT_TIMEOUT).then(() => {
            throw new Error('rejoin timed out');
          }),
        ]);
        if (this.isDestroyed) return;
        this.hostConn = conn;
        this.rejoining = false;
        this.startPing();
        this.rejoinListeners.forEach((listener) => listener('rejoined'));
        return;
      } catch {
        // an attempt that never opened must not show up later
        try {
          conn.close();
        } catch {
          // ignore
        }
      }
      await sleep(Math.min(3_000, 500 * attempt));
    }

    this.rejoining = false;
    if (this.isDestroyed) return;
    this.connectionListeners.forEach((listener) => listener(lost));
  }

  private cleanup() {
    this._mode = 'disconnected';
    this.connections = {};
    this.lastSeen = {};
    this.hostConn = undefined;
    this.rejoining = false;
    this.rttSamples = [];
    this.stopPing();
    clearInterval(this.watchdog);
    this.watchdog = undefined;

    for (const listener of this.listeners) {
      listener({ type: 'CONNECTION_CLOSED', payload: null }, null);
    }
    this.listeners = [];

    this.connectionListeners.forEach((listener) => listener());
    this.connectionListeners = [];
    this.rejoinListeners = [];
  }

  private async registerConnection(conn: DataConnection, notify = true) {
    return new Promise<DataConnection>((resolve, reject) => {
      let closed = false;

      conn.on('open', () => {
        this.connections[conn.connectionId] = conn;
        this.lastSeen[conn.connectionId] = performance.now();
        resolve(conn);
        if (notify) {
          this.connectionListeners.forEach((listener) => listener(conn));
        }

        conn.on('data', (data) => {
          this.lastSeen[conn.connectionId] = performance.now();

          if (
            !data ||
            typeof data !== 'object' ||
            !('type' in data) ||
            !('payload' in data) ||
            !data.type
          ) {
            console.warn('Music Together: Invalid data', data);
            return;
          }

          const event = data as ConnectionEventUnion;
          if (event.type === 'PING') {
            conn.send({ type: 'PONG', payload: event.payload });
            return;
          }
          if (event.type === 'PONG') {
            const rtt = performance.now() - event.payload.sentAt;
            if (rtt >= 0 && rtt < 5_000) {
              this.rttSamples.push(rtt);
              if (this.rttSamples.length > LATENCY_SAMPLES) {
                this.rttSamples.shift();
              }
              this._latency = Math.min(...this.rttSamples) / 2;
            }
            return;
          }

          for (const listener of this.listeners) {
            listener(data as ConnectionEventUnion, conn);
          }
        });
      });

      const onClose = (
        err?: PeerError<`${DataConnectionErrorType | BaseConnectionErrorType}`>,
      ) => {
        // an error is followed by a close, handle the connection only once
        if (closed) return;
        closed = true;

        if (conn.open) {
          conn.close();
        }

        delete this.connections[conn.connectionId];
        delete this.lastSeen[conn.connectionId];

        // the host dropped, try to get back before giving up on the session
        if (conn === this.hostConn && !this.isDestroyed) {
          this.hostConn = undefined;
          this.rejoin(conn).catch(() => undefined);
          reject(new Error('host connection lost'));
          return;
        }
        if (!notify) return;

        if (err) {
          if (err.type === 'connection-closed') {
            this.connectionListeners.forEach((listener) => listener());
          }
          reject(err);
        } else {
          this.connectionListeners.forEach((listener) => listener(conn));
        }
      };
      conn.on('error', onClose);
      conn.on('close', onClose);
    });
  }
}
