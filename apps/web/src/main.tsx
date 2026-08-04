import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, ClientToServerEvents, QueuePreferences, ServerToClientEvents } from "@rain/protocol";
import "./styles.css";

type AppStatus = "offline" | "ready" | "searching" | "matched" | "peer-left";
type RenderedMessage = { id: string; body: string; direction: "mine" | "theirs" };
type RainSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const defaultPreferences: QueuePreferences = { language: "en", interests: [] };

function RainLogo({ compact = false }: { compact?: boolean }) {
  return <svg className={compact ? "rain-mark rain-mark--compact" : "rain-mark"} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 39.5h27.2a10.8 10.8 0 0 0 1-21.5A15.2 15.2 0 0 0 17.3 23 8.4 8.4 0 0 0 18 39.5Z" />
    <path d="m23 46-2 6m12-6-2 6m12-6-2 6" />
  </svg>;
}

function App() {
  const socket = useRef<RainSocket | null>(null);
  const [status, setStatus] = useState<AppStatus>("offline");
  const [preferences, setPreferences] = useState<QueuePreferences>(defaultPreferences);
  const [interestDraft, setInterestDraft] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const [sharedInterests, setSharedInterests] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const client: RainSocket = io(import.meta.env.VITE_REALTIME_URL ?? "http://localhost:3001", {
      transports: ["websocket"],
      reconnectionAttempts: 5,
    });
    socket.current = client;
    client.on("connect", () => setStatus("ready"));
    client.on("disconnect", () => setStatus("offline"));
    client.on("queueJoined", () => setStatus("searching"));
    client.on("matched", (match) => {
      setMessages([]);
      setSharedInterests(match.sharedInterests);
      setStatus("matched");
    });
    client.on("message", (incoming) => {
      setMessages((items) => [...items, { id: incoming.clientMessageId, body: incoming.body, direction: "theirs" }]);
    });
    client.on("peerLeft", () => {
      setSharedInterests([]);
      setStatus("peer-left");
    });
    client.on("queueError", (error) => setNotice(error.message));
    client.on("reported", () => {
      setNotice("Thanks — the conversation has ended and your report is queued for review.");
      setStatus("ready");
      setSharedInterests([]);
    });
    return () => { client.disconnect(); };
  }, []);

  function beginSearch() {
    if (!socket.current?.connected) return setNotice("Connecting to chat… please try again in a moment.");
    setNotice(null);
    setMessages([]);
    setSharedInterests([]);
    setStatus("searching");
    socket.current.emit("joinQueue", preferences);
  }

  function leave() {
    socket.current?.emit("next");
    setStatus("ready");
    setSharedInterests([]);
  }

  function next() {
    if (!socket.current?.connected) return;
    setMessages([]);
    setSharedInterests([]);
    setStatus("searching");
    socket.current.emit("next");
    socket.current.emit("joinQueue", preferences);
  }

  function sendMessage() {
    const body = message.trim();
    if (!body || status !== "matched") return;
    const outgoing: ChatMessage = { clientMessageId: crypto.randomUUID(), body };
    socket.current?.emit("message", outgoing);
    setMessages((items) => [...items, { id: outgoing.clientMessageId, body, direction: "mine" }]);
    setMessage("");
  }

  function addInterests(raw: string) {
    const additions = raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length >= 2 && value.length <= 32);
    const interests = [...new Set([...preferences.interests, ...additions])].slice(0, 5);
    setPreferences({ ...preferences, interests });
    setInterestDraft("");
  }

  const searching = status === "searching";
  const inChat = status === "matched";

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Rain home"><RainLogo /> <span>rain</span></a>
        <span className={`connection ${status === "offline" ? "connection--offline" : ""}`}>
          <i /> {status === "offline" ? "Reconnecting" : "Secure chat"}
        </span>
      </header>

      <section className="hero">
        <p className="eyebrow">ANONYMOUS · ONE TO ONE</p>
        <h1>Say hello to<br /><em>someone new.</em></h1>
        <p className="lede">Choose a few interests to find a more relevant conversation—or leave them blank and let chance decide.</p>
      </section>

      <section className="chat-layout" aria-label="Random chat">
        <aside className="match-panel">
          <div>
            <p className="section-label">YOUR MATCH SETTINGS</p>
            <label className="field-label" htmlFor="language">Language</label>
            <select id="language" value={preferences.language} disabled={searching || inChat}
              onChange={(event) => setPreferences({ ...preferences, language: event.target.value })}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="pt">Portuguese</option>
            </select>
            <label className="field-label" htmlFor="interests">Interests <span>(up to 5)</span></label>
            <div className="interest-input">
              <input id="interests" value={interestDraft} disabled={searching || inChat} placeholder="music, movies, gaming"
                onChange={(event) => setInterestDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterests(interestDraft); } }} />
              <button type="button" disabled={!interestDraft || searching || inChat} onClick={() => addInterests(interestDraft)}>Add</button>
            </div>
            <div className="chips" aria-label="Selected interests">
              {preferences.interests.map((interest) => <button key={interest} type="button" className="chip" disabled={searching || inChat}
                onClick={() => setPreferences({ ...preferences, interests: preferences.interests.filter((item) => item !== interest) })}>{interest} <span>×</span></button>)}
            </div>
            <p className="fine-print">Selected interests require a shared interest. With none selected, you’ll meet anyone.</p>
          </div>

          <div className="voice-preview">
            <div className="voice-icon">⌁</div>
            <div><strong>Voice match</strong><p>Coming after text chat. Private WebRTC audio with separate live mic levels.</p></div>
          </div>
        </aside>

        <div className="conversation">
          <div className="conversation-head">
            <div>
              <p className="section-label">TEXT CHAT</p>
              <h2>{inChat ? "You’re connected" : searching ? "Looking for someone…" : status === "peer-left" ? "They left the chat" : "Ready when you are"}</h2>
            </div>
            {inChat && <button className="report" onClick={() => socket.current?.emit("reportPeer", { reason: "other" })}>Report</button>}
          </div>

          {inChat && sharedInterests.length > 0 && <p className="matched-on">You both like {sharedInterests.join(", ")}</p>}
          <div className="messages" aria-live="polite">
            {!inChat && <div className="empty-state"><div className={searching ? "pulse" : "orb"}><RainLogo compact /></div><p>{searching ? "Matching you with someone who shares your vibe." : "Conversations are anonymous. Be kind, protect your privacy, and leave anytime."}</p></div>}
            {messages.map((item) => <p className={`message message--${item.direction}`} key={item.id}>{item.body}</p>)}
          </div>

          {inChat ? <div className="composer"><textarea aria-label="Your message" value={message} maxLength={1000} placeholder="Write a message…"
            onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} />
            <button className="send" onClick={sendMessage} disabled={!message.trim()}>Send <span>↗</span></button></div>
            : <div className="idle-actions">
              {searching ? <button className="secondary" onClick={() => { socket.current?.emit("leaveQueue"); setStatus("ready"); }}>Cancel</button>
                : <button className="primary" disabled={status === "offline"} onClick={beginSearch}>{status === "peer-left" ? "Find someone new" : "Start a text chat"} <span>→</span></button>}
            </div>}
          {inChat && <div className="chat-actions"><button className="secondary" onClick={leave}>Leave</button><button className="primary" onClick={next}>Next person <span>→</span></button></div>}
        </div>
      </section>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
      <footer>18+ only · Don’t share personal information · <button onClick={() => setNotice("Reporting is available during a conversation. Blocking and persistent account controls belong in the production safety service.")}>Safety</button></footer>
    </main>
  );
}

export default App;

createRoot(document.getElementById("root")!).render(<App />);
