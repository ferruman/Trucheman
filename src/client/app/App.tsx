import { Routes } from "./routes";

export function App() {
  const path = location.pathname;

  return (
    <div className="app-shell">
      <aside className="command-rail">
        <a className="brand" href="/" aria-label="Trucheman home">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span>Trucheman</span>
        </a>
        <nav aria-label="Primary navigation">
          <a
            className={path === "/" || path.startsWith("/jobs/") ? "active" : ""}
            aria-current={path === "/" || path.startsWith("/jobs/") ? "page" : undefined}
            href="/"
          >
            Jobs
          </a>
          <a
            className={path === "/new" ? "active" : ""}
            aria-current={path === "/new" ? "page" : undefined}
            href="/new"
          >
            New book
          </a>
        </nav>
        <div className="local-status">
          <span className="status-light" aria-hidden="true" />
          <span>
            <strong>Local instance</strong>
            <small>127.0.0.1</small>
          </span>
        </div>
      </aside>
      <main className="workspace">
        <Routes />
      </main>
    </div>
  );
}
