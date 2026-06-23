'use client';

import { useEffect, useState } from 'react';
import { api } from '@/infrastructure/api/client';
import { Button } from '@/presentation/ui';
import { PUSH_TEST_TIMEOUT_MS } from '@/presentation/ui/timing';

/** VAPID base64url public key → the Uint8Array PushManager.subscribe expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = 'loading' | 'unsupported' | 'unavailable' | 'denied' | 'idle' | 'subscribed' | 'busy';

/** SW registration, or null if none becomes active shortly (dev: the SW is production-only). */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PUSH_TEST_TIMEOUT_MS)),
  ]);
}

export function PushToggle() {
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      const supported =
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window;
      if (!supported) return void (alive && setState('unsupported'));
      const { key } = await api.pushVapidKey().catch(() => ({ key: '' }));
      if (!key) return void (alive && setState('unavailable')); // server has no VAPID keys
      if (Notification.permission === 'denied') return void (alive && setState('denied'));
      const reg = await activeRegistration();
      if (!reg) return void (alive && setState('unavailable')); // no SW (e.g. dev build)
      const sub = await reg.pushManager.getSubscription();
      if (alive) setState(sub ? 'subscribed' : 'idle');
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function enable() {
    setState('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'idle');
      const { key } = await api.pushVapidKey();
      const reg = await activeRegistration();
      if (!key || !reg) return setState('unavailable');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // cast: the new TS lib types Uint8Array<ArrayBufferLike> doesn't unify with BufferSource.
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      const ok = await api.pushSubscribe(JSON.parse(JSON.stringify(sub)));
      setState(ok ? 'subscribed' : 'idle');
    } catch {
      setState('idle');
    }
  }

  async function disable() {
    setState('busy');
    try {
      const reg = await activeRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) {
        // SW not ready / no local subscription handle → we can't tell the server which endpoint to drop,
        // so the backend may still be delivering. DON'T claim disabled — keep 'subscribed' so a retry is
        // possible (showing 'idle' here lied while pushes kept arriving).
        setState('subscribed');
        return;
      }
      await api.pushUnsubscribe(sub.endpoint);
      await sub.unsubscribe();
      setState('idle');
    } catch {
      setState('subscribed'); // unsubscribe failed — keep the truthful 'subscribed', not a false 'idle'
    }
  }

  const note = (text: string) => <p className="text-faint text-xs leading-relaxed">{text}</p>;

  return (
    <div className="flex flex-col gap-2 border-border border-t pt-4">
      <p className="font-medium text-faint text-xs uppercase tracking-wide">Notifications</p>
      {state === 'loading' && note('Checking…')}
      {state === 'unsupported' && note('Push notifications are not supported in this browser.')}
      {state === 'unavailable' &&
        note('Push notifications are unavailable here (needs the installed/production app).')}
      {state === 'denied' &&
        note('Notifications are blocked — enable them for this site in your browser settings.')}
      {(state === 'idle' || state === 'busy') && (
        <>
          <Button onClick={enable} disabled={state === 'busy'} className="self-start">
            {state === 'busy' ? 'Enabling…' : 'Enable push alerts'}
          </Button>
          {note(
            'Get alerted on out-of-range, big PnL moves and closes — even when the app is closed.',
          )}
        </>
      )}
      {state === 'subscribed' && (
        <>
          <div className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-profit" />
            <span className="text-sm text-text">Push alerts on</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void api.pushTest()} className="self-start">
              Send test
            </Button>
            <Button variant="ghost" onClick={disable} className="self-start">
              Turn off
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
