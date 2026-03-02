import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: string;
}

interface AuthContextValue {
  user: AuthUser;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;

    const loadUser = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/auth/me", {
          credentials: "include",
        });

        if (!active) return;

        if (response.status === 401) {
          window.location.href = "/api/auth/login";
          return;
        }

        if (!response.ok) {
          throw new Error(
            `Authentication service returned ${response.status}.`,
          );
        }

        const payload = (await response.json()) as { user: AuthUser };
        setUser(payload.user);
      } catch (error) {
        console.error("Failed to load authenticated user:", error);
        if (active) {
          setError(
            error instanceof Error
              ? error.message
              : "Failed to load authentication state.",
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadUser();

    return () => {
      active = false;
    };
  }, [retryCount]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.href = "/api/auth/login";
    }
  }, []);

  const retry = useCallback(() => {
    setRetryCount((value) => value + 1);
  }, []);

  const value = useMemo(() => {
    if (!user) return null;
    return { user, logout };
  }, [logout, user]);

  if (loading) {
    return (
      <div className="h-screen bg-[#f5f8fc] flex items-center justify-center text-sm text-slate-600">
        Authenticating...
      </div>
    );
  }

  if (!value) {
    if (error) {
      return (
        <div className="h-screen bg-[#f5f8fc] flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border bg-white p-5 text-sm">
            <div className="font-semibold text-slate-800 mb-2">
              Authentication unavailable
            </div>
            <div className="text-slate-600 mb-4">{error}</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={retry}
                className="px-3 py-1.5 rounded bg-[#21314d] text-white text-xs hover:opacity-90"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => {
                  window.location.href = "/api/auth/login";
                }}
                className="px-3 py-1.5 rounded border text-xs"
              >
                Go to Login
              </button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
