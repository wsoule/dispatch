import {
  type ApiClient,
  connectEvents,
  createApiClient,
  type ServerEvent,
} from '@dispatch/client';
import {
  fromBase64Url,
  type PairingOffer,
  publicKeyOf,
  type RelaySocket,
  RemoteConnection,
  type RemoteStatus,
  toBase64Url,
} from '@dispatch/remote';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// The one link to the paired Mac. Every request and the event stream go
// through a RemoteConnection: end-to-end encrypted, through the relay, with
// no token on the phone. What is kept is this phone's X25519 key and the
// daemon's, in the keychain, readable only on this device while unlocked.

const STORE_KEY = 'dispatch.pairing.v1';
/** Requests name the daemon by path only; the tunnel ignores the origin. */
const DAEMON = 'dispatch-remote://daemon';

interface Paired {
  relay: string;
  daemonId: string;
  daemonKey: string;
  daemonName: string;
  phoneSecret: string;
}

interface RemoteValue {
  /** False until the keychain has been read. */
  loaded: boolean;
  paired: Paired | null;
  status: RemoteStatus;
  client: ApiClient | null;
  /** Every ServerEvent the daemon sends while connected. */
  subscribe(listener: (event: ServerEvent) => void): () => void;
  /** Pairs with the offer a QR code carried; resolves once the Mac accepted. */
  pair(offer: PairingOffer, deviceName: string): Promise<void>;
  /** Forgets the Mac on this phone. Unpair it on the Mac too. */
  forget(): Promise<void>;
  retry(): void;
}

const RemoteContext = createContext<RemoteValue | null>(null);

const random = (length: number) => getRandomBytes(length);
const socket = (url: string) => new WebSocket(url) as unknown as RelaySocket;

async function readPaired(): Promise<Paired | null> {
  const text = await SecureStore.getItemAsync(STORE_KEY);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Paired>;
    return typeof value.relay === 'string' &&
      typeof value.daemonId === 'string' &&
      typeof value.daemonKey === 'string' &&
      typeof value.phoneSecret === 'string'
      ? {
          relay: value.relay,
          daemonId: value.daemonId,
          daemonKey: value.daemonKey,
          daemonName: value.daemonName ?? 'Your Mac',
          phoneSecret: value.phoneSecret,
        }
      : null;
  } catch {
    return null;
  }
}

function writePaired(paired: Paired): Promise<void> {
  return SecureStore.setItemAsync(STORE_KEY, JSON.stringify(paired), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

function connectionFor(
  paired: Paired,
  pairing?: { offerId: string; code: Uint8Array; name: string }
): RemoteConnection {
  const secretKey = fromBase64Url(paired.phoneSecret);
  return new RemoteConnection({
    relay: paired.relay,
    daemonId: paired.daemonId,
    daemonKey: fromBase64Url(paired.daemonKey),
    phone: { secretKey, publicKey: publicKeyOf(secretKey) },
    ...(pairing === undefined ? {} : { pairing }),
    createWebSocket: socket,
    random,
  });
}

export function RemoteProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [paired, setPaired] = useState<Paired | null>(null);
  const [status, setStatus] = useState<RemoteStatus>({ kind: 'stopped' });
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());

  useEffect(() => {
    void readPaired().then((value) => {
      setPaired(value);
      if (value !== null) setConnection(connectionFor(value));
      setLoaded(true);
    });
  }, []);

  // One live connection and one event stream at a time.
  useEffect(() => {
    if (connection === null) return;
    const offStatus = connection.onStatus(setStatus);
    setStatus(connection.current());
    connection.start();
    const stopEvents = connectEvents(DAEMON, () => {}, {
      createSocket: connection.createSocket,
      reconnectDelayMs: 2000,
      onEvent: (event) => {
        for (const listener of listeners.current) listener(event);
      },
    });
    return () => {
      stopEvents();
      offStatus();
      connection.stop();
    };
  }, [connection]);

  const client = useMemo(
    () =>
      connection === null
        ? null
        : createApiClient(DAEMON, undefined, {
            fetch: connection.fetch as typeof fetch,
          }),
    [connection]
  );

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const pair = useCallback(
    async (offer: PairingOffer, deviceName: string): Promise<void> => {
      const next: Paired = {
        relay: offer.relay,
        daemonId: offer.daemonId,
        daemonKey: toBase64Url(offer.daemonKey),
        daemonName: offer.name,
        phoneSecret: toBase64Url(random(32)),
      };
      const trial = connectionFor(next, {
        offerId: offer.offerId,
        code: offer.code,
        name: deviceName,
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          trial.stop();
          reject(new Error('Your Mac did not answer. Is the daemon running?'));
        }, 20_000);
        const off = trial.onStatus((s) => {
          if (s.kind === 'ready') {
            clearTimeout(timer);
            off();
            resolve();
          } else if (s.kind === 'refused' || s.kind === 'offline') {
            clearTimeout(timer);
            off();
            trial.stop();
            reject(
              new Error(
                s.kind === 'offline'
                  ? 'Your Mac is not online. Start Dispatch there and try again.'
                  : refusalText(s.reason)
              )
            );
          }
        });
        trial.start();
      });
      // Paired: keep the keys, and keep this very connection.
      await writePaired(next);
      setPaired(next);
      setConnection(trial);
    },
    []
  );

  const forget = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORE_KEY);
    setConnection(null);
    setPaired(null);
    setStatus({ kind: 'stopped' });
  }, []);

  const retry = useCallback(() => connection?.retryNow(), [connection]);

  const value = useMemo<RemoteValue>(
    () => ({
      loaded,
      paired,
      status,
      client,
      subscribe,
      pair,
      forget,
      retry,
    }),
    [loaded, paired, status, client, subscribe, pair, forget, retry]
  );
  return (
    <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>
  );
}

export function useRemote(): RemoteValue {
  const value = useContext(RemoteContext);
  if (value === null) throw new Error('useRemote outside RemoteProvider');
  return value;
}

function refusalText(reason: string): string {
  switch (reason) {
    case 'pairing-expired':
      return 'That code has expired or was already used. Run `dispatch phone pair` for a new one.';
    case 'unknown-device':
      return 'Your Mac no longer knows this phone. Pair it again.';
    case 'wrong-daemon':
      return 'That code is for a different Mac.';
    default:
      return 'Your Mac refused the connection.';
  }
}

/** One line for the connection, as a person reads it. */
export function statusText(status: RemoteStatus): string {
  switch (status.kind) {
    case 'ready':
      return `Connected to ${status.name}`;
    case 'connecting':
      return 'Connecting…';
    case 'offline':
      return 'Your Mac is offline';
    case 'refused':
      return refusalText(status.reason);
    case 'error':
      return `Not connected: ${status.message}`;
    case 'stopped':
      return 'Not connected';
  }
}
