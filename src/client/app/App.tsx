import { Routes } from "./routes";

export function App() {
  const path = location.pathname;

  return (
    <div className="app-shell">
      <aside className="command-rail">
        <a className="brand" href="/" aria-label="Book Translator home">
          <span className="brand-mark" aria-hidden="true">
            BT
          </span>
          <span>
            Book
            <br />
            Translator
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a className={path === "/" || path.startsWith("/jobs/") ? "active" : ""} href="/">
            <span aria-hidden="true">01</span> Jobs
          </a>
          <a className={path === "/new" ? "active" : ""} href="/new">
            <span aria-hidden="true">02</span> New book
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
