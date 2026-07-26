/**
 * Sync transport.
 *
 * A thin adapter between the engine and the HTTP client. Kept separate so the
 * engine can be tested against an in-memory fake with no network at all — which
 * matters, because the engine's interesting behaviour is exactly what happens
 * when the network misbehaves.
 */

import { SYNC_PROTOCOL_VERSION, type SyncPullResponse, type SyncPushResponse } from '@orbit/types';

import type { ApiClient } from '../api/client';
import type { SyncTransport } from './engine';

export class HttpSyncTransport implements SyncTransport {
  constructor(private readonly api: ApiClient) {}

  /**
   * Push a batch.
   *
   * The timeout is generous: a device draining a week's backlog sends large
   * payloads over a link that may be barely usable, and a premature timeout
   * turns a slow-but-succeeding push into a retry storm.
   */
  async push(body: unknown): Promise<SyncPushResponse> {
    return this.api.post<SyncPushResponse>('/sync/push', body, { timeoutMs: 120_000 });
  }

  async pull(params: { since: number; limit: number }): Promise<SyncPullResponse> {
    return this.api.get<SyncPullResponse>('/sync/pull', {
      query: {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        since: params.since,
        limit: params.limit,
      },
      timeoutMs: 90_000,
    });
  }
}

/**
 * In-memory transport for tests and for the offline demo mode.
 * Records what it was asked to send so assertions can inspect it.
 */
export class FakeSyncTransport implements SyncTransport {
  readonly pushes: unknown[] = [];
  pullResponses: SyncPullResponse[] = [];
  pushResponse: SyncPushResponse | null = null;

  async push(body: unknown): Promise<SyncPushResponse> {
    this.pushes.push(body);
    return (
      this.pushResponse ?? {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        results: [],
        cursor: 0 as SyncPushResponse['cursor'],
        serverTime: new Date().toISOString() as SyncPushResponse['serverTime'],
      }
    );
  }

  async pull(): Promise<SyncPullResponse> {
    return (
      this.pullResponses.shift() ?? {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        changes: [],
        cursor: 0 as SyncPullResponse['cursor'],
        hasMore: false,
        serverTime: new Date().toISOString() as SyncPullResponse['serverTime'],
      }
    );
  }
}
