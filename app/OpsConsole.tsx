"use client";

import { useEffect, useMemo, useState } from "react";

type OpsRequest = {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  risk: string;
  result: string | null;
  worker_log: string | null;
  created_at: number;
  updated_at: number;
};

const requestTypes = [
  { value: "mac_status", label: "상태 확인" },
  { value: "file_cleanup", label: "파일 정리" },
  { value: "development", label: "개발 요청" },
  { value: "custom", label: "기타 작업" },
];

const statusLabel: Record<string, string> = {
  queued: "대기",
  approval_required: "승인 필요",
  running: "진행 중",
  done: "완료",
  failed: "실패",
};

export function OpsConsole() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [requests, setRequests] = useState<OpsRequest[]>([]);
  const [type, setType] = useState("mac_status");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(
    () => [...requests].sort((a, b) => b.created_at - a.created_at),
    [requests],
  );

  async function loadRequests() {
    const response = await fetch("/api/requests", { cache: "no-store" });
    if (response.status === 401) {
      setAuthed(false);
      return;
    }
    const data = (await response.json()) as { requests: OpsRequest[] };
    setAuthed(true);
    setRequests(data.requests);
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void loadRequests(), 0);
    const timer = window.setInterval(() => void loadRequests(), 8000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage("비밀번호가 맞지 않습니다.");
      return;
    }
    setPassword("");
    setAuthed(true);
    await loadRequests();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, title, body }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage("요청을 저장하지 못했습니다.");
      return;
    }
    setTitle("");
    setBody("");
    setMessage("요청을 큐에 넣었습니다.");
    await loadRequests();
  }

  async function approve(id: string) {
    await fetch(`/api/requests/${id}/approve`, { method: "POST" });
    await loadRequests();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    setAuthed(false);
  }

  if (!authed) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div>
            <p className="eyebrow">Hermes Mac Ops</p>
            <h1>Mac Studio 요청 콘솔</h1>
            <p className="muted">
              외부에서는 요청만 남기고, 실제 실행은 Mac Studio의 로컬 worker가
              제한된 권한으로 처리합니다.
            </p>
          </div>
          <form onSubmit={login} className="login-form">
            <label>
              비밀번호
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              접속
            </button>
            {message ? <p className="error">{message}</p> : null}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hermes Mac Ops</p>
          <h1>요청 콘솔</h1>
        </div>
        <button className="ghost" onClick={logout} type="button">
          로그아웃
        </button>
      </header>

      <section className="workspace">
        <form className="request-form" onSubmit={submit}>
          <div className="form-row">
            <label>
              작업 유형
              <select value={type} onChange={(event) => setType(event.target.value)}>
                {requestTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              제목
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="예: 다운로드 폴더 정리"
                required
              />
            </label>
          </div>
          <label>
            요청 내용
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="무엇을 확인하거나 처리할지 적어주세요."
              rows={8}
              required
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              요청 보내기
            </button>
            {message ? <span>{message}</span> : null}
          </div>
        </form>

        <section className="queue-panel">
          <div className="section-head">
            <h2>작업 큐</h2>
            <button className="ghost" onClick={loadRequests} type="button">
              새로고침
            </button>
          </div>
          <div className="request-list">
            {sorted.length === 0 ? (
              <p className="empty">아직 요청이 없습니다.</p>
            ) : (
              sorted.map((item) => (
                <article className="request-item" key={item.id}>
                  <div className="item-head">
                    <div>
                      <p className="type">{labelForType(item.type)}</p>
                      <h3>{item.title}</h3>
                    </div>
                    <span className={`badge ${item.status}`}>
                      {statusLabel[item.status] ?? item.status}
                    </span>
                  </div>
                  <p className="body-text">{item.body}</p>
                  {item.status === "approval_required" ? (
                    <button className="approve" onClick={() => approve(item.id)} type="button">
                      실행 승인
                    </button>
                  ) : null}
                  {item.result ? <pre>{item.result}</pre> : null}
                  <p className="timestamp">{new Date(item.updated_at).toLocaleString()}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function labelForType(value: string) {
  return requestTypes.find((item) => item.value === value)?.label ?? value;
}
