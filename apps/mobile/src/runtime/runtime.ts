/**
 * Application runtime.
 *
 * One object owns the database handle, the outbox, the repositories, the API
 * client, and the sync engine. It is constructed once, after login, when the
 * user identity is known — repositories stamp `orgId` and `userId` onto every
 * row they write, so they cannot exist before there is a user.
 *
 * Everything the UI needs hangs off here. Screens never construct a repository
 * or reach for the database directly.
 */

import type { AuthSession, AuthTokens } from '@orbit/types';
import Constants from 'expo-constants';

import { ApiClient, type TokenStore } from '../api/client';
import { Database, getDatabase } from '../db/database';
import { AttachmentRepository } from '../db/repositories/attachment.repository';
import { InspectionRepository } from '../db/repositories/inspection.repository';
import { ResponseRepository } from '../db/repositories/response.repository';
import { TemplateRepository } from '../db/repositories/template.repository';
import { META_KEYS } from '../db/schema';
import { secureStorage, storage, STORAGE_KEYS } from '../lib/storage';
import {
  attachEngine,
  detachEngine,
  recoverInterruptedWork,
  registerBackgroundSync,
  startForegroundTriggers,
} from '../sync/background';
import { type EngineOptions, type NetworkState, SyncEngine } from '../sync/engine';
import { Outbox } from '../sync/outbox';
import { HttpSyncTransport } from '../sync/transport';
import { MediaUploader } from '../sync/uploader';

export interface Identity {
  userId: string;
  orgId: string;
  deviceId: string;
  role: string;
  permissions: string[];
}

export interface Runtime {
  db: Database;
  api: ApiClient;
  outbox: Outbox;
  engine: SyncEngine;
  uploader: MediaUploader;
  identity: Identity;
  repositories: {
    inspections: InspectionRepository;
    responses: ResponseRepository;
    attachments: AttachmentRepository;
    templates: TemplateRepository;
  };
  dispose(): void;
}

/** In-memory token cache backed by the keychain. */
class SessionTokenStore implements TokenStore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private deviceId: string | null = null;

  async hydrate(): Promise<void> {
    // Read once at construction. Keychain reads are async and comparatively
    // slow; doing one per request would add latency to every API call.
    this.accessToken = await secureStorage.get(secureStorage.keys.ACCESS_TOKEN);
    this.refreshToken = await secureStorage.get(secureStorage.keys.REFRESH_TOKEN);
    this.deviceId = await secureStorage.get(secureStorage.keys.DEVICE_ID);
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  setTokens(tokens: AuthTokens): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    // Persisted without awaiting: the in-memory copy is what the next request
    // uses, and a keychain write failure must not stall the request that
    // triggered the refresh.
    void secureStorage.set(secureStorage.keys.ACCESS_TOKEN, tokens.accessToken);
    void secureStorage.set(secureStorage.keys.REFRESH_TOKEN, tokens.refreshToken);
  }

  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
    void secureStorage.set(secureStorage.keys.DEVICE_ID, deviceId);
  }

  clear(): void {
    this.accessToken = null;
    this.refreshToken = null;
    void secureStorage.remove(secureStorage.keys.ACCESS_TOKEN);
    void secureStorage.remove(secureStorage.keys.REFRESH_TOKEN);
  }
}

export const tokenStore = new SessionTokenStore();

/**
 * The backend this installation talks to.
 *
 * `app.config.ts` resolves this at build time and refuses to package a release
 * without it, so on a shipped artefact it is always present. There is
 * deliberately no localhost fallback: on a packaged build it could never be
 * reached anyway, and silently substituting it turns a configuration mistake
 * into "every request times out", which reads as a backend outage rather than
 * a build error. Failing loudly names the actual problem.
 */
export function resolveApiUrl(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (!configured) {
    throw new Error(
      'No API URL is configured. This build was packaged without ' +
        'EXPO_PUBLIC_API_URL — it cannot reach any backend.',
    );
  }
  return configured;
}

export interface BuildRuntimeOptions {
  session: Pick<AuthSession, 'user' | 'organization' | 'permissions'> & {
    device: { id: string };
  };
  getNetwork: () => NetworkState;
  onAuthFailure: () => void;
  onStatusChange?: EngineOptions['onStatusChange'];
}

/**
 * Build the runtime for a signed-in user.
 *
 * Ordering matters: the database must be open before the outbox can recover
 * in-flight entries, and the outbox must exist before repositories, because
 * every repository write enqueues through it.
 */
export async function buildRuntime(options: BuildRuntimeOptions): Promise<Runtime> {
  const db = await getDatabase();
  await tokenStore.hydrate();

  const { session } = options;
  const identity: Identity = {
    userId: String(session.user.id),
    orgId: String(session.organization.id),
    deviceId: session.device.id,
    role: String(session.user.role),
    permissions: session.permissions,
  };

  // Persist identity so a cold start can rebuild the runtime before the network
  // is reachable — an inspector opening the app underground must still work.
  db.setMeta(META_KEYS.USER_ID, identity.userId);
  db.setMeta(META_KEYS.ORG_ID, identity.orgId);
  db.setMeta(META_KEYS.DEVICE_ID, identity.deviceId);
  tokenStore.setDeviceId(identity.deviceId);

  const api = new ApiClient({
    baseUrl: resolveApiUrl(),
    tokens: tokenStore,
    onAuthFailure: options.onAuthFailure,
    isOnline: () => options.getNetwork().isConnected,
  });

  const outbox = new Outbox(db, { deviceId: identity.deviceId, userId: identity.userId });

  const repositories = {
    inspections: new InspectionRepository(db, outbox, identity),
    responses: new ResponseRepository(db, outbox, identity),
    attachments: new AttachmentRepository(db, outbox, identity),
    templates: new TemplateRepository(db),
  };

  const uploader = new MediaUploader({
    api,
    attachments: repositories.attachments,
  });

  const engine = new SyncEngine({
    db,
    outbox,
    uploader,
    transport: new HttpSyncTransport(api),
    getNetwork: options.getNetwork,
    wifiOnlyMedia: () => storage.getBoolean(STORAGE_KEYS.SYNC_WIFI_ONLY) ?? true,
    onStatusChange: options.onStatusChange,
  });

  // Anything the last session left mid-flight is recovered before the first
  // sync of this one — an outbox row stuck IN_FLIGHT or an upload stuck
  // UPLOADING would otherwise never be retried.
  const recovered = await recoverInterruptedWork();
  if (recovered.operations > 0 || recovered.uploads > 0) {
    console.info(
      `[sync] recovered ${recovered.operations} operation(s) and ${recovered.uploads} upload(s) after restart`,
    );
  }

  // The OS background task has no access to the React tree, so it reaches the
  // engine through a module handle.
  attachEngine(engine);

  // Re-asserted on every cold start rather than only on first launch: a device
  // reboot clears iOS's scheduled tasks entirely.
  void registerBackgroundSync();

  const stopTriggers = startForegroundTriggers(engine);

  return {
    db,
    api,
    outbox,
    engine,
    uploader,
    identity,
    repositories,
    dispose(): void {
      engine.abort();
      stopTriggers();
      detachEngine();
    },
  };
}

/** Identity recovered from local storage, for offline cold start. */
export function cachedIdentity(db: Database): Identity | null {
  const userId = db.getMeta(META_KEYS.USER_ID);
  const orgId = db.getMeta(META_KEYS.ORG_ID);
  const deviceId = db.getMeta(META_KEYS.DEVICE_ID);
  if (!userId || !orgId || !deviceId) return null;
  return { userId, orgId, deviceId, role: 'INSPECTOR', permissions: [] };
}
