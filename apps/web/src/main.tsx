import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, ClientToServerEvents, QueuePreferences, ServerToClientEvents } from "@rain/protocol";
import "./styles.css";

type AppStatus = "offline" | "ready" | "searching" | "matched" | "peer-left";
type ChatMode = "text" | "voice";
type VoiceState = "idle" | "requesting" | "previewing" | "blocked" | "unsupported";
type RenderedMessage = { id: string; body: string; direction: "mine" | "theirs" };
type RainSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const defaultPreferences: QueuePreferences = { language: "en", interests: [] };
const realtimeUrl = import.meta.env.VITE_REALTIME_URL;

function RainLogo({ compact = false }: { compact?: boolean }) {
  return <svg className={compact ? "rain-mark rain-mark--compact" : "rain-mark"} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 39.5h27.2a10.8 10.8 0 0 0 1-21.5A15.2 15.2 0 0 0 17.3 23 8.4 8.4 0 0 0 18 39.5Z" />
    <path d="m23 46-2 6m12-6-2 6m12-6-2 6" />
  </svg>;
}

function MicrophoneIcon({ muted = false }: { muted?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8.25" y="3" width="7.5" height="11" rx="3.75" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
    {muted && <path className="mic-slash" d="m4 4 16 16" />}
  </svg>;
}

function VoiceOrb({ level, muted = false, peer = false }: { level: number; muted?: boolean; peer?: boolean }) {
  const orbStyle = { "--level": String(muted ? 0 : level) } as CSSProperties;
  return <div className={`voice-orb ${peer ? "voice-orb--peer" : ""} ${muted ? "voice-orb--muted" : ""}`} style={orbStyle}>
    <div className="voice-orb__bars" aria-hidden="true">
      {Array.from({ length: 28 }, (_, index) => <i key={index} style={{ "--bar": String(index) } as CSSProperties} />)}
    </div>
    <div className="voice-orb__core"><MicrophoneIcon muted={muted} /></div>
  </div>;
}

function VoiceStage({
  voiceState,
  muted,
  localLevel,
  peerLevel,
  onStartPreview,
  onStopPreview,
  onToggleMute,
  onFindMatch,
}: {
  voiceState: VoiceState;
  muted: boolean;
  localLevel: number;
  peerLevel: number;
  onStartPreview: () => void;
  onStopPreview: () => void;
  onToggleMute: () => void;
  onFindMatch: () => void;
}) {
  const previewing = voiceState === "previewing";
  const helper = voiceState === "requesting" ? "Waiting for microphone permission…"
    : voiceState === "blocked" ? "Microphone access was blocked. Enable it in your browser settings to try again."
      : voiceState === "unsupported" ? "This browser does not support microphone access."
        : previewing ? "Your microphone is live. The second ring is a visual preview of a future match."
          : "Test your microphone now. Voice matching will activate when the voice backend is connected.";

  return <div className="voice-stage">
    <div className="voice-stage__header">
      <div><p className="section-label">VOICE CHAT</p><h2>Talk, don’t type.</h2></div>
      <span className={`voice-state ${previewing ? "voice-state--live" : ""}`}><i /> {previewing ? "Mic preview live" : "Voice beta"}</span>
    </div>
    <p className="voice-stage__helper">{helper}</p>

    <div className="voice-room">
      <div className="voice-person">
        <VoiceOrb level={localLevel} muted={muted} />
        <strong>You</strong>
        <span>{muted ? "Muted" : previewing ? "Listening" : "Mic off"}</span>
      </div>
      <div className="voice-room__connection" aria-hidden="true"><span /><i>⌁</i><span /></div>
      <div className="voice-person">
        <VoiceOrb level={peerLevel} peer />
        <strong>Someone new</strong>
        <span>{previewing ? "Audio visual preview" : "Waiting to match"}</span>
      </div>
    </div>

    <div className="voice-controls">
      {previewing && <button className={`mic-control ${muted ? "mic-control--muted" : ""}`} onClick={onToggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"}><MicrophoneIcon muted={muted} /></button>}
      {previewing ? <button className="secondary" onClick={onStopPreview}>Stop mic preview</button>
        : <button className="primary" disabled={voiceState === "requesting" || voiceState === "unsupported"} onClick={onStartPreview}>Test your mic <span>◌</span></button>}
      <button className="voice-match-button" onClick={onFindMatch}>Find a voice match <span>→</span></button>
    </div>
    <p className="voice-stage__privacy">Voice is private and one-to-one. You will always see when your microphone is active.</p>
  </div>;
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
  const [mode, setMode] = useState<ChatMode>("text");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [localLevel, setLocalLevel] = useState(0);
  const [peerLevel, setPeerLevel] = useState(0);
  const voiceStream = useRef<MediaStream | null>(null);
  const voiceContext = useRef<AudioContext | null>(null);
  const voiceAnimation = useRef<number | null>(null);

  useEffect(() => {
    if (!realtimeUrl && import.meta.env.PROD) {
      setNotice("Text chat is being set up. Please check back shortly.");
      return;
    }
    const client: RainSocket = io(realtimeUrl ?? "http://localhost:3001", {
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

  function stopVoicePreview() {
    if (voiceAnimation.current !== null) cancelAnimationFrame(voiceAnimation.current);
    voiceAnimation.current = null;
    voiceStream.current?.getTracks().forEach((track) => track.stop());
    voiceStream.current = null;
    void voiceContext.current?.close();
    voiceContext.current = null;
    setMuted(false);
    setLocalLevel(0);
    setPeerLevel(0);
    setVoiceState("idle");
  }

  useEffect(() => () => stopVoicePreview(), []);

  async function startVoicePreview() {
    if (!navigator.mediaDevices?.getUserMedia) return setVoiceState("unsupported");
    stopVoicePreview();
    setVoiceState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      voiceStream.current = stream;
      voiceContext.current = context;
      setVoiceState("previewing");

      const sampleLevel = () => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
        setLocalLevel(Math.min(1, rms * 6));
        // This is a visual-only peer signal until the WebRTC/LiveKit track is connected.
        setPeerLevel(0.12 + Math.max(0, Math.sin(Date.now() / 280)) * 0.24 + Math.max(0, Math.sin(Date.now() / 97)) * 0.1);
        voiceAnimation.current = requestAnimationFrame(sampleLevel);
      };
      sampleLevel();
    } catch {
      setVoiceState("blocked");
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    voiceStream.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  }

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
            <div className="mode-switch" role="tablist" aria-label="Chat type">
              <button type="button" role="tab" aria-selected={mode === "text"} className={mode === "text" ? "mode-switch__active" : ""} onClick={() => setMode("text")}>Text</button>
              <button type="button" role="tab" aria-selected={mode === "voice"} className={mode === "voice" ? "mode-switch__active" : ""} onClick={() => setMode("voice")}>Voice</button>
            </div>
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

          <button type="button" className={`voice-preview ${mode === "voice" ? "voice-preview--active" : ""}`} onClick={() => setMode("voice")}>
            <div className="voice-icon">⌁</div>
            <div><strong>Voice match</strong><p>Coming after text chat. Private WebRTC audio with separate live mic levels.</p></div>
          </button>
        </aside>

        {mode === "voice" ? <VoiceStage voiceState={voiceState} muted={muted} localLevel={localLevel} peerLevel={peerLevel}
          onStartPreview={startVoicePreview} onStopPreview={stopVoicePreview} onToggleMute={toggleMute}
          onFindMatch={() => setNotice("Voice matching is ready for the backend. Connect the WebRTC token and match events to activate it.")} />
          : <div className="conversation">
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
        </div>}
      </section>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
      <footer>18+ only · Don’t share personal information · <button onClick={() => setNotice("Reporting is available during a conversation. Blocking and persistent account controls belong in the production safety service.")}>Safety</button></footer>
    </main>
  );
}

export default App;

createRoot(document.getElementById("root")!).render(<App />);
