import { useEffect, useRef, useState } from "react";
import { api, getStoredToken, setAuthToken } from "./api";
import ProjectsView from "./ProjectsView";
import type { User } from "./types";

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const token = getStoredToken();
    if (!token) {
      setAuthChecked(true);
      return () => {
        mountedRef.current = false;
      };
    }
    void api
      .me()
      .then(({ user }) => {
        if (mountedRef.current) setCurrentUser(user);
      })
      .catch(() => {
        if (mountedRef.current) setAuthToken("");
      })
      .finally(() => {
        if (mountedRef.current) setAuthChecked(true);
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.createUser(name);
      setAuthToken(user.token);
      setCurrentUser({ id: user.id, name: user.name });
      setNameInput("");
    } catch (reason) {
      setAuthToken("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    setAuthToken("");
    setCurrentUser(null);
  };

  if (!authChecked) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={signIn}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Who's working?</h1>
          <p>Enter your name. You'll see the projects you own or are a member of.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Your name
            <input
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              maxLength={60}
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !nameInput.trim()}>
            {busy ? <Spinner /> : "Continue"}
          </button>
        </form>
      </main>
    );
  }

  return <ProjectsView currentUser={currentUser} onSignOut={signOut} />;
}
