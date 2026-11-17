async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`Push request failed (${response.status})`);
  return response;
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("راه‌اندازی اعلان مرورگر طول کشید؛ دوباره تلاش کنید.")
            ),
          12000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export async function saveSubscription(subscription: PushSubscription) {
  const serialized = subscription.toJSON();
  if (!serialized.keys?.p256dh || !serialized.keys.auth)
    throw new Error("کلید اشتراک مرورگر معتبر نیست.");
  await api("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
    }),
  });
}
export async function removeSubscription(subscription: PushSubscription) {
  await api("/api/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  if (!(await subscription.unsubscribe()))
    throw new Error(
      "اشتراک از حساب حذف شد، اما لغو در مرورگر کامل نشد؛ دوباره تلاش کنید."
    );
}
export async function cleanupPushBeforeSignOut() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return;
  const subscription = await registration.pushManager?.getSubscription();
  if (subscription) await removeSubscription(subscription);
  if (registration.getNotifications) {
    const notifications = await registration.getNotifications();
    for (const notification of notifications) notification.close();
  }
}

// Call from a button click, after the user has signed in.
export async function enablePush() {
  if (!pushSupported())
    throw new Error("Push is unsupported in this browser/context");
  const response = await api("/api/push/config");
  const { publicKey } = await response.json();
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Notification permission was not granted");
  const registration = await pushRegistration();
  let sub = await registration.pushManager.getSubscription();
  let created = false;
  try {
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      created = true;
    }
    await saveSubscription(sub);
  } catch (error) {
    if (created && sub) await sub.unsubscribe().catch(() => false);
    throw error;
  }
}
export async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const sub = await registration?.pushManager.getSubscription();
  if (sub) await removeSubscription(sub);
}
