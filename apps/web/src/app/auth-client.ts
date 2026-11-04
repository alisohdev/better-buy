"use client";

import { useCallback, useEffect, useState } from "react";

type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
};

type Session = {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type Identity = { session: Session; user: User };
type AuthError = { message: string; status?: number };
type AuthResult<T> =
  { data: T; error?: undefined } | { data?: undefined; error: AuthError };

const authBase =
  process.env.NEXT_PUBLIC_AUTH_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8787" : "");
const changedEvent = "better-buy-auth-changed";

async function request<T>(
  path: string,
  init?: RequestInit
): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${authBase}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    return {
      error: { message: "The authentication service could not be reached." },
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? (body.error as { message?: unknown })
        : null;
    return {
      error: {
        message:
          error && typeof error.message === "string"
            ? error.message
            : "Authentication request failed.",
        status: response.status,
      },
    };
  }
  return { data: body as T };
}

function notifyAuthChanged() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(changedEvent));
}

async function getSession(): Promise<{ data: Identity | null }> {
  const result = await request<Identity | null>("/api/auth/get-session");
  if (result.error) throw new Error(result.error.message);
  return { data: result.data };
}

function useSession() {
  const [data, setData] = useState<Identity | null>(null);
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setPending(true);
    try {
      const result = await getSession();
      setData(result.data);
      setError(null);
      return result;
    } catch (failure) {
      const nextError =
        failure instanceof Error
          ? failure
          : new Error("Session could not be loaded.");
      setError(nextError);
      throw nextError;
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getSession().then(
        (result) => {
          if (!active) return;
          setData(result.data);
          setError(null);
          setPending(false);
        },
        (failure: unknown) => {
          if (!active) return;
          setError(
            failure instanceof Error
              ? failure
              : new Error("Session could not be loaded.")
          );
          setPending(false);
        }
      );
    };
    refresh();
    window.addEventListener(changedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(changedEvent, refresh);
    };
  }, []);

  return { data, isPending, error, refetch };
}

const signUpEmail = async (input: {
  name: string;
  email: string;
  password: string;
}) => {
  const result = await request<{ token: string; user: User }>(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  if (!result.error) notifyAuthChanged();
  return result;
};

const signInEmail = async (input: { email: string; password: string }) => {
  const result = await request<{ token: string; user: User }>(
    "/api/auth/sign-in/email",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  if (!result.error) notifyAuthChanged();
  return result;
};

const signInSocial = async (input: {
  provider: "google";
  callbackURL?: string;
}) => {
  if (input.provider !== "google")
    return { error: { message: "Unsupported sign-in provider." } };
  const base = authBase || window.location.origin;
  const url = new URL("/api/auth/google/start", base);
  url.searchParams.set("callbackURL", input.callbackURL || "/");
  window.location.assign(url.toString());
  return { data: { redirect: true as const, url: url.toString() } };
};

const signOut = async () => {
  const result = await request<{ success: boolean }>("/api/auth/sign-out", {
    method: "POST",
  });
  if (!result.error) notifyAuthChanged();
  return result;
};

export const authClient = {
  useSession,
  getSession,
  signUp: { email: signUpEmail },
  signIn: { email: signInEmail, social: signInSocial },
  signOut,
};
