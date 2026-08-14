import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, ClientToServerEvents, QueuePreferences, ServerToClientEvents } from "@rain/protocol";

type Plan = "free" | "plus" | "pro";
type AppStage = "landing" | "onboarding" | "app";
type Section = "forecast" | "text" | "voice" | "video" | "circles" | "inbox" | "profile" | "plans";
type MatchStatus = "offline" | "ready" | "searching" | "matched" | "peer-left";
type MediaState = "idle" | "requesting" | "previewing" | "blocked" | "unsupported";
type Sound = "tap" | "match" | "send" | "notice";

type Profile = {
  name: string;
  avatar?: string;
  bio: string;
  identity: string;
  seeking: string;
  interests: string[];
  plan: Plan;
  karma: number;
  soundEnabled: boolean;
  createdAt: string;
};

type Member = {
  id: string;
  name: string;
  handle: string;
  tone: string;
  karma: number;
  status: "online" | "away" | "in a chat";
  interests: string[];
};

type DmMessage = { id: string; body: string; from: "me" | "them"; createdAt: string };
type DmThread = { memberId: string; messages: DmMessage[] };
type GroupMessage = { id: string; author: string; body: string; createdAt: string; mine?: boolean };
type Channel = { id: string; name: string; description: string; members: number; live?: boolean };
type RainSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const realtimeUrl = import.meta.env.VITE_REALTIME_URL;
const defaultQueue: QueuePreferences = { language: "en", interests: [] };
const storageKeys = {
  profile: "rain.profile.v2",
  friends: "rain.friends.v2",
  dms: "rain.dms.v2",
  groupMessages: "rain.groups.v2",
  memberKarma: "rain.member-karma.v2",
};

const members: Member[] = [
  { id: "aria", name: "Aria", handle: "aria.afterdark", tone: "#c3b7ff", karma: 824, status: "online", interests: ["music", "film", "late nights"] },
  { id: "mika", name: "Mika", handle: "mika.makes", tone: "#f7b6d2", karma: 612, status: "online", interests: ["design", "coffee", "photography"] },
  { id: "sol", name: "Sol", handle: "solstice", tone: "#ffd59a", karma: 1_208, status: "in a chat", interests: ["games", "anime", "languages"] },
  { id: "jules", name: "Jules", handle: "jules.wav", tone: "#9de2d0", karma: 439, status: "away", interests: ["indie", "books", "art"] },
  { id: "noor", name: "Noor", handle: "noor.nights", tone: "#a9c8ff", karma: 703, status: "online", interests: ["travel", "food", "stories"] },
];

const channels: Channel[] = [
  { id: "after-rain", name: "after-rain", description: "A quiet place to end the day.", members: 126, live: true },
  { id: "music-club", name: "music-club", description: "Share what is on repeat.", members: 84, live: true },
  { id: "watch-party", name: "watch-party", description: "Find your next watch list.", members: 53 },
  { id: "language-exchange", name: "language-exchange", description: "Practice, listen, learn.", members: 41, live: true },
];

const defaultGroupMessages: Record<string, GroupMessage[]> = {
  "after-rain": [
    { id: "g1", author: "Aria", body: "What is everyone listening to tonight?", createdAt: "8:40 PM" },
    { id: "g2", author: "Mika", body: "Something slow and rainy, obviously.", createdAt: "8:42 PM" },
  ],
  "music-club": [{ id: "g3", author: "Sol", body: "Drop one song that deserves more attention.", createdAt: "8:29 PM" }],
  "watch-party": [{ id: "g4", author: "Noor", body: "Any low-stakes movie recommendations?", createdAt: "7:56 PM" }],
  "language-exchange": [{ id: "g5", author: "Jules", body: "French learners, what are you watching this week?", createdAt: "7:18 PM" }],
};

function readStored<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function useStoredState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional for the frontend prototype. */ }
  }, [key, value]);
  return [value, setValue];
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "R";
}

function now() {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
}

function RainLogo({ compact = false }: { compact?: boolean }) {
  return <svg className={compact ? "rain-mark rain-mark--compact" : "rain-mark"} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 39.5h27.2a10.8 10.8 0 0 0 1-21.5A15.2 15.2 0 0 0 17.3 23 8.4 8.4 0 0 0 18 39.5Z" />
    <path d="m23 46-2 6m12-6-2 6m12-6-2 6" />
  </svg>;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const shared = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "spark": return <svg {...shared}><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>;
    case "message": return <svg {...shared}><path d="M20 11.5a7.7 7.7 0 0 1-8 7.5 9 9 0 0 1-3.3-.6L4 20l1.3-4A7.2 7.2 0 0 1 4 11.5 7.7 7.7 0 0 1 12 4a7.7 7.7 0 0 1 8 7.5Z" /></svg>;
    case "mic": return <svg {...shared}><rect x="8.25" y="3" width="7.5" height="11" rx="3.75" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></svg>;
    case "video": return <svg {...shared}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></svg>;
    case "users": return <svg {...shared}><path d="M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-4A4.5 4.5 0 0 0 3 18.5V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="M17 11a3 3 0 1 0 0-6M21 20v-1.5a4.5 4.5 0 0 0-3-4.25" /></svg>;
    case "inbox": return <svg {...shared}><path d="M4 4h16v15H4z" /><path d="M4 14h4l2 3h4l2-3h4" /></svg>;
    case "user": return <svg {...shared}><circle cx="12" cy="8" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0" /></svg>;
    case "settings": return <svg {...shared}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.2 2.2-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51v.1h-3.1v-.1a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06-2.2-2.2.06-.06A1.65 1.65 0 0 0 7 15a1.65 1.65 0 0 0-1.51-1H5.4v-3.1h.1A1.65 1.65 0 0 0 7 9.4a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.2-2.2.06.06A1.65 1.65 0 0 0 10.7 5a1.65 1.65 0 0 0 1-1.51v-.1h3.1v.1a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06 2.2 2.2-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1h.1V14H21a1.65 1.65 0 0 0-1.6 1Z" /></svg>;
    case "arrow": return <svg {...shared}><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
    case "lock": return <svg {...shared}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case "plus": return <svg {...shared}><path d="M12 5v14M5 12h14" /></svg>;
    case "more": return <svg {...shared}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></svg>;
    case "check": return <svg {...shared}><path d="m5 12 4.2 4.2L19 6.5" /></svg>;
    case "bolt": return <svg {...shared}><path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z" /></svg>;
    case "camera": return <svg {...shared}><path d="M4 8h4l1.5-2h5L16 8h4v11H4Z" /><circle cx="12" cy="13" r="3.2" /></svg>;
    case "volume": return <svg {...shared}><path d="M4 10h4l5-4v12l-5-4H4Z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></svg>;
    default: return <svg {...shared}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

function Avatar({ profile, member, size = "md" }: { profile?: Pick<Profile, "name" | "avatar">; member?: Member; size?: "sm" | "md" | "lg" }) {
  const name = profile?.name ?? member?.name ?? "Rain";
  const image = profile?.avatar;
  const style = member ? ({ "--avatar-tone": member.tone } as CSSProperties) : undefined;
  return <div className={`avatar avatar--${size}`} style={style}>{image ? <img src={image} alt="" /> : initials(name)}</div>;
}

function PlanPill({ plan }: { plan: Plan }) {
  return <span className={`plan-pill plan-pill--${plan}`}>{plan === "free" ? "Free" : plan === "plus" ? "Rain Plus" : "Rain Pro"}</span>;
}

function App() {
  const [profile, setProfile] = useStoredState<Profile | null>(storageKeys.profile, null);
  const [stage, setStage] = useState<AppStage>(() => profile ? "app" : "landing");

  if (stage === "landing") return <Landing onStart={() => setStage(profile ? "app" : "onboarding")} onSignIn={() => setStage(profile ? "app" : "onboarding")} />;
  if (stage === "onboarding") return <Onboarding onComplete={(nextProfile) => { setProfile(nextProfile); setStage("app"); }} onBack={() => setStage("landing")} />;
  return <Workspace profile={profile ?? createFallbackProfile()} onProfileChange={setProfile} onExit={() => setStage("landing")} />;
}

function createFallbackProfile(): Profile {
  return { name: "Rain guest", bio: "", identity: "Prefer not to say", seeking: "Everyone", interests: [], plan: "free", karma: 0, soundEnabled: true, createdAt: new Date().toISOString() };
}

function Landing({ onStart, onSignIn }: { onStart: () => void; onSignIn: () => void }) {
  const [activeFeature, setActiveFeature] = useState<"text" | "voice" | "video" | "circles">("text");
  const features = [
    { id: "text" as const, icon: "message", label: "Random text", title: "A conversation can start with one line.", body: "Drop in anonymously, match around common interests, and leave whenever you want. Random chats disappear when they end." },
    { id: "voice" as const, icon: "mic", label: "Voice", title: "Hear the moment, not the noise.", body: "Opt into one-to-one audio with a visible live microphone signal. No microphone is used until you tap to join." },
    { id: "video" as const, icon: "video", label: "Video", title: "Face-to-face on your terms.", body: "A camera-first flow with a calm preview, clear controls, and a deliberate match step." },
    { id: "circles" as const, icon: "users", label: "Circles", title: "Find the room that fits tonight.", body: "Small live channels for music, late-night talk, languages, and whatever the forecast brings." },
  ];
  const active = features.find((feature) => feature.id === activeFeature)!;

  return <main className="landing">
    <div className="landing__rain landing__rain--one" aria-hidden="true" /><div className="landing__rain landing__rain--two" aria-hidden="true" />
    <header className="landing-nav">
      <a className="brand" href="#top" aria-label="Rain home"><RainLogo /><span>rain</span></a>
      <nav aria-label="Main navigation"><a href="#ways">Ways to connect</a><a href="#safe">Built for better chats</a><button type="button" onClick={onSignIn}>Sign in</button></nav>
      <button className="button button--light landing-nav__cta" type="button" onClick={onStart}>Create your space <Icon name="arrow" size={16} /></button>
    </header>

    <section className="landing-hero" id="top">
      <div className="landing-hero__copy">
        <p className="overline"><span /> A better kind of random</p>
        <h1>Meet the <em>unexpected.</em><br />Keep what matters.</h1>
        <p>Rain is a calm place to find someone new. Start a temporary conversation, make a genuine connection, or join a live Circle.</p>
        <div className="landing-hero__actions"><button className="button button--light" onClick={onStart}>Start with Rain <Icon name="arrow" size={17} /></button><a className="text-link" href="#ways">See what’s inside <span>↓</span></a></div>
        <div className="landing-proof"><div className="avatar-stack"><Avatar member={members[0]} size="sm" /><Avatar member={members[1]} size="sm" /><Avatar member={members[4]} size="sm" /></div><p><strong>Made for chance encounters</strong><br />with more control and less noise.</p></div>
      </div>
      <div className="landing-hero__scene" aria-label="Preview of Rain">
        <div className="scene-orbit scene-orbit--outer" /><div className="scene-orbit scene-orbit--inner" />
        <div className="scene-cloud"><RainLogo /><span>rain</span></div>
        <div className="scene-card scene-card--message"><span className="scene-card__dot" /><p>Matched on <strong>music · films</strong></p><div className="scene-bubble">What has been on repeat lately?</div></div>
        <div className="scene-card scene-card--voice"><span className="voice-mini"><i /><i /><i /><i /><i /></span><p><strong>Voice is live</strong><br />Both mics are on</p></div>
        <div className="scene-card scene-card--circle"><span className="scene-card__people"><Avatar member={members[0]} size="sm" /><Avatar member={members[4]} size="sm" /></span><p><strong># after-rain</strong><br />126 people here now</p></div>
      </div>
    </section>

    <section className="landing-ways" id="ways">
      <div className="section-heading"><p className="overline">Four ways in</p><h2>Choose the energy.<br /><em>We shape the flow around it.</em></h2></div>
      <div className="feature-showcase">
        <div className="feature-tabs" role="tablist" aria-label="Ways to use Rain">
          {features.map((feature, index) => <button key={feature.id} role="tab" aria-selected={activeFeature === feature.id} className={activeFeature === feature.id ? "feature-tab feature-tab--active" : "feature-tab"} onClick={() => setActiveFeature(feature.id)}><span className="feature-tab__number">0{index + 1}</span><Icon name={feature.icon} /><span>{feature.label}</span><Icon name="arrow" size={15} /></button>)}
        </div>
        <div className={`feature-panel feature-panel--${active.id}`}>
          <div><span className="feature-panel__icon"><Icon name={active.icon} size={22} /></span><p className="overline">{active.label}</p><h3>{active.title}</h3><p>{active.body}</p><button className="text-link text-link--button" onClick={onStart}>Try {active.label.toLowerCase()} <Icon name="arrow" size={15} /></button></div>
          <FeatureIllustration feature={active.id} />
        </div>
      </div>
    </section>

    <section className="landing-safety" id="safe">
      <div><p className="overline">Designed with intention</p><h2>Temporary by default.<br /><em>Personal when it earns it.</em></h2></div>
      <div className="safety-grid"><article><Icon name="lock" /><h3>Random means temporary</h3><p>Random text, voice, and video rooms vanish when either person leaves.</p></article><article><Icon name="users" /><h3>Connections are mutual</h3><p>Send a friend request only when you both want to keep the conversation going.</p></article><article><Icon name="spark" /><h3>Trust grows quietly</h3><p>Rain score supports kinder matching and better community spaces.</p></article></div>
    </section>

    <section className="landing-cta"><div><p className="overline">The forecast is open</p><h2>Something good<br />could happen <em>next.</em></h2></div><button className="button button--light" onClick={onStart}>Build your Rain profile <Icon name="arrow" size={17} /></button></section>
    <footer className="landing-footer"><span>© 2026 Rain</span><span>18+ only · Your privacy matters · Be kind</span></footer>
  </main>;
}

function FeatureIllustration({ feature }: { feature: "text" | "voice" | "video" | "circles" }) {
  if (feature === "voice") return <div className="illustration illustration--voice"><div className="sound-ring sound-ring--one" /><div className="sound-ring sound-ring--two" /><div className="sound-ring sound-ring--three" /><div className="illustration__mic"><Icon name="mic" size={28} /></div><div className="illustration__levels">{Array.from({ length: 22 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}</div></div>;
  if (feature === "video") return <div className="illustration illustration--video"><div className="video-window"><div className="video-window__bar"><span /><span /><span /></div><div className="video-window__face"><div /><i /></div><div className="video-window__controls"><button><Icon name="mic" size={14} /></button><button><Icon name="video" size={14} /></button><button className="video-window__end">×</button></div></div></div>;
  if (feature === "circles") return <div className="illustration illustration--circles"><div className="circle-line"><span># after-rain</span><i>126</i></div><div className="circle-line circle-line--active"><span># music-club</span><i>84</i></div><div className="circle-line"><span># language-exchange</span><i>41</i></div><div className="circle-members">{members.slice(0, 4).map((member) => <Avatar key={member.id} member={member} size="sm" />)}<strong>+64</strong></div></div>;
  return <div className="illustration illustration--text"><div className="text-match"><p>Finding a shared signal…</p><div className="text-match__orbs"><span><Avatar member={members[1]} size="md" /></span><i>↔</i><span><RainLogo compact /></span></div><div className="text-match__tags"><b>design</b><b>coffee</b><b>movies</b></div></div></div>;
}

function Onboarding({ onComplete, onBack }: { onComplete: (profile: Profile) => void; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | undefined>();
  const [bio, setBio] = useState("");
  const [identity, setIdentity] = useState("Prefer not to say");
  const [seeking, setSeeking] = useState("Everyone");
  const [interests, setInterests] = useState<string[]>([]);
  const [interestDraft, setInterestDraft] = useState("");
  const [accepted, setAccepted] = useState(false);
  const steps = ["Your space", "Your match", "Your forecast", "Ready"];

  function addInterest() {
    const next = interestDraft.trim().toLowerCase();
    if (!next || interests.includes(next) || interests.length >= 5) return;
    setInterests([...interests, next]); setInterestDraft("");
  }

  async function readAvatar(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 900_000) return;
    const result = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    setAvatar(result);
  }

  function finish() {
    onComplete({ name: name.trim() || "Rain guest", avatar, bio: bio.trim(), identity, seeking, interests, plan: "free", karma: 0, soundEnabled: true, createdAt: new Date().toISOString() });
  }

  const canContinue = step === 0 ? name.trim().length >= 2 : step === 2 ? accepted : true;
  return <main className="onboarding">
    <header className="onboarding__header"><button className="brand brand--button" onClick={onBack}><RainLogo /><span>rain</span></button><span className="onboarding__help">Already have a profile? <button onClick={onBack}>Go back</button></span></header>
    <div className="onboarding__progress" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((label, index) => <div className={index <= step ? "onboarding-step onboarding-step--active" : "onboarding-step"} key={label}><i>{index < step ? <Icon name="check" size={12} /> : index + 1}</i><span>{label}</span></div>)}</div>
    <section className="onboarding-card">
      {step === 0 && <div className="flow-step"><p className="overline">Step 01 · Set the signal</p><h1>Make it feel like <em>you.</em></h1><p className="flow-step__lede">A profile helps people recognize a connection worth keeping. You can edit this anytime.</p><div className="profile-picker"><label className="avatar-upload"><Avatar profile={{ name: name || "You", avatar }} size="lg" /><span><Icon name="camera" size={15} /> Add photo</span><input type="file" accept="image/*" onChange={(event) => void readAvatar(event.target.files?.[0])} /></label><div><label htmlFor="profile-name">Display name</label><input id="profile-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="What should people call you?" maxLength={24} /><label htmlFor="profile-bio">A little about you <span>optional</span></label><textarea id="profile-bio" value={bio} onChange={(event) => setBio(event.target.value)} placeholder="A few words, a favorite thing, a tiny signal." maxLength={120} /></div></div><p className="field-note">Photos stay in your profile. Random chats never save a transcript.</p></div>}
      {step === 1 && <div className="flow-step"><p className="overline">Step 02 · Shape the match</p><h1>Tell Rain who you<br />hope to <em>meet.</em></h1><p className="flow-step__lede">These preferences are optional and private. They never appear in your public profile.</p><div className="choice-block"><span>How do you describe yourself?</span><div className="choice-grid">{["Woman", "Man", "Nonbinary", "Prefer not to say"].map((choice) => <button className={identity === choice ? "choice choice--selected" : "choice"} key={choice} onClick={() => setIdentity(choice)}>{choice}{identity === choice && <Icon name="check" size={15} />}</button>)}</div></div><div className="choice-block"><span>Who would you like to meet?</span><div className="choice-grid">{["Everyone", "Women", "Men", "Nonbinary people"].map((choice) => <button className={seeking === choice ? "choice choice--selected" : "choice"} key={choice} onClick={() => setSeeking(choice)}>{choice}{seeking === choice && <Icon name="check" size={15} />}</button>)}</div><p className="field-note"><Icon name="lock" size={13} /> Gender preferences are available with Rain Plus or Pro. Free always matches with everyone.</p></div></div>}
      {step === 2 && <div className="flow-step"><p className="overline">Step 03 · Set the forecast</p><h1>What pulls you<br />into a <em>conversation?</em></h1><p className="flow-step__lede">Choose up to five interests. They help Rain find a shared starting point.</p><div className="interest-builder"><div><input value={interestDraft} onChange={(event) => setInterestDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterest(); } }} placeholder="music, travel, film…" maxLength={32} /><button onClick={addInterest} disabled={!interestDraft.trim()}>Add</button></div><div className="chips chips--large">{interests.map((interest) => <button className="chip" key={interest} onClick={() => setInterests(interests.filter((item) => item !== interest))}>{interest}<span>×</span></button>)}</div><div className="suggestions">{["music", "gaming", "movies", "art", "languages", "late nights"].filter((item) => !interests.includes(item)).slice(0, 4).map((item) => <button key={item} onClick={() => { if (interests.length < 5) setInterests([...interests, item]); }}>+ {item}</button>)}</div></div><label className="safety-check"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span><strong>I’m 18 or older</strong> and I agree to keep Rain respectful. I understand random chats are temporary and I will not share personal information.</span></label></div>}
      {step === 3 && <div className="flow-step flow-step--ready"><div className="ready-orbit"><RainLogo /><i /><i /><i /></div><p className="overline">Your space is ready</p><h1>The forecast looks<br /><em>interesting.</em></h1><p className="flow-step__lede">Start with a quick text match, browse a Circle, or make your profile yours. You are always in control of what you share.</p><div className="ready-summary"><Avatar profile={{ name: name || "Rain guest", avatar }} size="md" /><div><strong>{name || "Rain guest"}</strong><span>{interests.length ? interests.join(" · ") : "Open to chance"}</span></div><PlanPill plan="free" /></div></div>}
      <div className="flow-actions"><button className="button button--ghost" onClick={() => step === 0 ? onBack() : setStep(step - 1)}>{step === 0 ? "Back" : "Back"}</button>{step < 3 ? <button className="button button--light" disabled={!canContinue} onClick={() => setStep(step + 1)}>Continue <Icon name="arrow" size={16} /></button> : <button className="button button--light" onClick={finish}>Enter Rain <Icon name="arrow" size={16} /></button>}</div>
    </section>
  </main>;
}

function Workspace({ profile, onProfileChange, onExit }: { profile: Profile; onProfileChange: Dispatch<SetStateAction<Profile | null>>; onExit: () => void }) {
  const [section, setSection] = useState<Section>("forecast");
  const [notice, setNotice] = useState<string | null>(null);
  const [friends, setFriends] = useStoredState<string[]>(storageKeys.friends, ["aria", "mika"]);
  const [dms, setDms] = useStoredState<DmThread[]>(storageKeys.dms, [
    { memberId: "aria", messages: [{ id: "d1", from: "them", body: "Glad we found each other again ☁", createdAt: "Yesterday" }] },
    { memberId: "mika", messages: [{ id: "d2", from: "them", body: "The design channel is very good tonight.", createdAt: "Mon" }] },
  ]);
  const [groupMessages, setGroupMessages] = useStoredState<Record<string, GroupMessage[]>>(storageKeys.groupMessages, defaultGroupMessages);
  const [memberKarma, setMemberKarma] = useStoredState<Record<string, number>>(storageKeys.memberKarma, {});
  const audioContext = useRef<AudioContext | null>(null);

  const playSound = useCallback((sound: Sound) => {
    if (!profile.soundEnabled) return;
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const frequencies: Record<Sound, number> = { tap: 440, match: 587, send: 698, notice: 330 };
      oscillator.type = sound === "match" ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(frequencies[sound], context.currentTime);
      if (sound === "match") oscillator.frequency.linearRampToValueAtTime(880, context.currentTime + .12);
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.025, context.currentTime + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + (sound === "match" ? .32 : .12));
      oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + (sound === "match" ? .34 : .14));
    } catch { /* Sound feedback should never interrupt chat. */ }
  }, [profile.soundEnabled]);

  function go(next: Section) { playSound("tap"); setSection(next); }
  function updateProfile(patch: Partial<Profile>) { onProfileChange((current) => current ? { ...current, ...patch } : current); }
  function featureGate(required: Plan, message: string) {
    const allowed = required === "plus" ? profile.plan !== "free" : profile.plan === "pro";
    if (allowed) return true;
    playSound("notice"); setNotice(message); setSection("plans"); return false;
  }
  function addFriend(memberId: string) {
    if (!friends.includes(memberId)) { setFriends([...friends, memberId]); playSound("match"); setNotice("Friend request accepted. Your private thread is ready in Inbox."); }
  }
  function removeFriend(memberId: string) { setFriends(friends.filter((id) => id !== memberId)); setDms(dms.filter((thread) => thread.memberId !== memberId)); setNotice("Connection removed. Their saved DM is no longer in your inbox."); }
  function sendDm(memberId: string, body: string) {
    const message = { id: crypto.randomUUID(), from: "me" as const, body, createdAt: now() };
    setDms((current) => current.some((thread) => thread.memberId === memberId) ? current.map((thread) => thread.memberId === memberId ? { ...thread, messages: [...thread.messages, message] } : thread) : [...current, { memberId, messages: [message] }]); playSound("send");
  }
  function sendGroup(channelId: string, body: string) { setGroupMessages((current) => ({ ...current, [channelId]: [...(current[channelId] ?? []), { id: crypto.randomUUID(), author: profile.name, body, createdAt: now(), mine: true }] })); playSound("send"); }
  function vouch(memberId: string) { if (!featureGate("pro", "Rain score controls are part of Rain Pro.")) return; setMemberKarma((current) => ({ ...current, [memberId]: (current[memberId] ?? 0) + 1 })); playSound("match"); setNotice("A quiet +1 was added. Rain score can never be downvoted from chat."); }

  const friendMembers = members.filter((member) => friends.includes(member.id));
  return <main className="workspace">
    <aside className="app-rail"><button className="app-brand" onClick={() => go("forecast")} aria-label="Rain forecast"><RainLogo compact /></button><div className="app-rail__line" /><nav aria-label="Rain areas"><RailButton icon="spark" label="Forecast" active={section === "forecast"} onClick={() => go("forecast")} /><RailButton icon="message" label="Drop in" active={section === "text"} onClick={() => go("text")} /><RailButton icon="mic" label="Voice" active={section === "voice"} onClick={() => go("voice")} /><RailButton icon="video" label="Video" active={section === "video"} onClick={() => go("video")} /><RailButton icon="users" label="Circles" active={section === "circles"} onClick={() => go("circles")} /><RailButton icon="inbox" label="Inbox" active={section === "inbox"} badge={friendMembers.length || undefined} onClick={() => go("inbox")} /></nav><div className="app-rail__bottom"><RailButton icon="settings" label="Plans" active={section === "plans"} onClick={() => go("plans")} /><button className="rail-avatar" onClick={() => go("profile")} aria-label="Open profile"><Avatar profile={profile} size="sm" /></button></div></aside>
    <aside className="app-sidebar"><Sidebar section={section} profile={profile} friends={friendMembers} onSelect={go} onExit={onExit} /></aside>
    <section className="app-content">{section === "forecast" && <Forecast profile={profile} onNavigate={go} onUpgrade={() => go("plans")} />} {section === "text" && <TextMatch profile={profile} onUpgrade={featureGate} onAddFriend={addFriend} onVouch={vouch} onNotice={setNotice} onSound={playSound} />} {section === "voice" && <MediaMatch kind="voice" profile={profile} onUpgrade={featureGate} onNotice={setNotice} onSound={playSound} />} {section === "video" && <MediaMatch kind="video" profile={profile} onUpgrade={featureGate} onNotice={setNotice} onSound={playSound} />} {section === "circles" && <Circles profile={profile} messages={groupMessages} onSend={sendGroup} onSound={playSound} />} {section === "inbox" && <Inbox profile={profile} friends={friendMembers} dms={dms} onSend={sendDm} onRemove={removeFriend} onSound={playSound} />} {section === "profile" && <ProfileView profile={profile} onChange={updateProfile} onUpgrade={() => go("plans")} />} {section === "plans" && <Plans profile={profile} onSelect={(plan) => { updateProfile({ plan }); playSound("match"); setNotice(plan === "free" ? "You are using the free plan." : `${plan === "plus" ? "Rain Plus" : "Rain Pro"} selected for this frontend preview. Connect Stripe before charging anyone.`); }} />}</section>
    {notice && <div className="notice notice--app" role="status"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
  </main>;
}

function RailButton({ icon, label, active, badge, onClick }: { icon: string; label: string; active: boolean; badge?: number; onClick: () => void }) {
  return <button className={active ? "rail-button rail-button--active" : "rail-button"} onClick={onClick} aria-label={label}><Icon name={icon} size={19} />{badge ? <b>{badge}</b> : null}<span>{label}</span></button>;
}

function Sidebar({ section, profile, friends, onSelect, onExit }: { section: Section; profile: Profile; friends: Member[]; onSelect: (section: Section) => void; onExit: () => void }) {
  const title = section === "circles" ? "Circles" : section === "inbox" ? "Inbox" : section === "plans" ? "Membership" : section === "profile" ? "Your profile" : "Rain";
  return <><header className="sidebar-head"><div><strong>{title}</strong><span>{section === "circles" ? "Live rooms and people" : section === "inbox" ? "Saved connections" : section === "plans" ? "Choose your forecast" : "Your space, your pace"}</span></div><button aria-label="More options"><Icon name="more" size={18} /></button></header>{section === "circles" ? <div className="sidebar-scroll"><p className="sidebar-label">LIVE CIRCLES</p>{channels.map((channel) => <button className="channel-link" onClick={() => onSelect("circles")} key={channel.id}><span>#</span><div><strong>{channel.name}</strong><small>{channel.members} here now</small></div>{channel.live && <i />}</button>)}<p className="sidebar-label sidebar-label--spaced">ONLINE NOW · {members.filter((member) => member.status === "online").length}</p>{members.map((member) => <div className="member-row" key={member.id}><Avatar member={member} size="sm" /><div><strong>{member.name}</strong><span>{member.status}</span></div><i className={`presence presence--${member.status.replaceAll(" ", "-")}`} /></div>)}</div> : section === "inbox" ? <div className="sidebar-scroll"><p className="sidebar-label">DIRECT MESSAGES</p>{friends.length ? friends.map((member) => <button className="dm-link" key={member.id} onClick={() => onSelect("inbox")}><Avatar member={member} size="sm" /><div><strong>{member.name}</strong><span>{member.status === "online" ? "Online now" : member.status}</span></div>{member.status === "online" && <i />}</button>) : <p className="sidebar-empty">Connections you keep will appear here.</p>}</div> : <div className="sidebar-scroll sidebar-scroll--default"><div className="sidebar-profile"><Avatar profile={profile} size="lg" /><div><strong>{profile.name}</strong><span>@rainfall</span><PlanPill plan={profile.plan} /></div></div><div className="sidebar-quote"><Icon name="spark" size={17} /><p>Random rooms disappear. Friends and DMs stay with you.</p></div><button className="sidebar-action" onClick={() => onSelect("text")}><Icon name="message" size={17} />Start a random chat <Icon name="arrow" size={15} /></button><button className="sidebar-action" onClick={() => onSelect("circles")}><Icon name="users" size={17} />Browse Circles <Icon name="arrow" size={15} /></button><div className="sidebar-meta"><button onClick={() => onSelect("profile")}>Settings</button><button onClick={onExit}>Sign out</button></div></div>}</>;
}

function Forecast({ profile, onNavigate, onUpgrade }: { profile: Profile; onNavigate: (section: Section) => void; onUpgrade: () => void }) {
  return <div className="forecast page-enter"><header className="content-head"><div><p className="overline">YOUR FORECAST</p><h1>Good evening, <em>{profile.name.split(" ")[0]}.</em></h1><p>There are people waiting for a conversation, a room, or a small moment of chance.</p></div><div className="forecast-status"><span><i /> Live now</span><strong>423</strong><small>people in Rain</small></div></header><section className="forecast-hero"><div className="forecast-hero__copy"><p className="overline">Start somewhere unexpected</p><h2>What kind of<br />connection <em>fits tonight?</em></h2><button className="button button--light" onClick={() => onNavigate("text")}>Drop into text <Icon name="arrow" size={16} /></button></div><div className="forecast-hero__visual"><div className="forecast-cloud"><RainLogo /><span>rain</span></div><div className="forecast-drop forecast-drop--one" /><div className="forecast-drop forecast-drop--two" /><div className="forecast-drop forecast-drop--three" /><div className="forecast-signal"><span>shared interests</span><b>music · art · nights</b></div></div></section><section className="mode-grid"><ModeCard icon="message" number="01" title="Random text" body="The easiest way to start. Anonymous and temporary by default." action="Start a chat" onClick={() => onNavigate("text")} /><ModeCard icon="mic" number="02" title="Voice match" body="Hear the energy first. Your mic is always visibly controlled." action="Open voice" onClick={() => onNavigate("voice")} /><ModeCard icon="video" number="03" title="Video match" body="Preview your camera, then choose whether to join." action="Open video" onClick={() => onNavigate("video")} /><ModeCard icon="users" number="04" title="Circles" body="Small rooms around a shared signal, live right now." action="Browse circles" onClick={() => onNavigate("circles")} /></section><section className="forecast-lower"><div className="activity-card"><p className="overline">YOUR RAIN SCORE</p><div><strong>{profile.plan === "free" ? "—" : profile.karma}</strong><span>{profile.plan === "free" ? "Upgrade to see your trust signal" : "A quiet signal of kinder conversations"}</span></div>{profile.plan === "free" && <button className="text-link text-link--button" onClick={onUpgrade}>Explore Rain Pro <Icon name="arrow" size={14} /></button>}</div><div className="activity-card activity-card--friends"><p className="overline">KEEP THE GOOD ONES</p><div className="avatar-stack">{members.slice(0, 3).map((member) => <Avatar member={member} size="md" key={member.id} />)}</div><span>Friends turn a temporary chat into a saved DM. It always takes mutual consent.</span><button className="text-link text-link--button" onClick={() => onNavigate("inbox")}>Open inbox <Icon name="arrow" size={14} /></button></div></section></div>;
}

function ModeCard({ icon, number, title, body, action, onClick }: { icon: string; number: string; title: string; body: string; action: string; onClick: () => void }) {
  return <article className="mode-card"><span className="mode-card__number">{number}</span><span className="mode-card__icon"><Icon name={icon} size={20} /></span><h3>{title}</h3><p>{body}</p><button onClick={onClick}>{action} <Icon name="arrow" size={15} /></button></article>;
}

function TextMatch({ profile, onUpgrade, onAddFriend, onVouch, onNotice, onSound }: { profile: Profile; onUpgrade: (required: Plan, message: string) => boolean; onAddFriend: (id: string) => void; onVouch: (id: string) => void; onNotice: (message: string) => void; onSound: (sound: Sound) => void }) {
  const socket = useRef<RainSocket | null>(null);
  const [status, setStatus] = useState<MatchStatus>("offline");
  const [queue, setQueue] = useState<QueuePreferences>({ language: "en", interests: profile.interests });
  const [interestDraft, setInterestDraft] = useState("");
  const [messages, setMessages] = useState<{ id: string; body: string; mine: boolean }[]>([]);
  const [draft, setDraft] = useState("");
  const [shared, setShared] = useState<string[]>([]);
  const [currentPeer] = useState<Member>(() => members[Math.floor(Math.random() * members.length)]);

  useEffect(() => {
    if (!realtimeUrl && import.meta.env.PROD) return;
    const client: RainSocket = io(realtimeUrl ?? "http://localhost:3001", { transports: ["websocket"], reconnectionAttempts: 5 }); socket.current = client;
    client.on("connect", () => setStatus("ready")); client.on("disconnect", () => setStatus("offline")); client.on("queueJoined", () => setStatus("searching"));
    client.on("matched", (match) => { setMessages([]); setShared(match.sharedInterests); setStatus("matched"); onSound("match"); });
    client.on("message", (message) => setMessages((current) => [...current, { id: message.clientMessageId, body: message.body, mine: false }]));
    client.on("peerLeft", () => { setStatus("peer-left"); setShared([]); }); client.on("queueError", (error) => onNotice(error.message));
    return () => { client.disconnect(); };
  }, [onNotice, onSound]);

  const lockedGender = profile.plan === "free";
  const lockedLanguage = profile.plan === "free";
  const matching = status === "searching"; const matched = status === "matched";
  function addInterest() { const value = interestDraft.trim().toLowerCase(); if (!value || queue.interests.includes(value) || queue.interests.length >= 5) return; setQueue({ ...queue, interests: [...queue.interests, value] }); setInterestDraft(""); }
  function begin() { if (!socket.current?.connected) { onNotice("Rain is reconnecting to the text gateway. Please try again in a moment."); return; } setMessages([]); setShared([]); setStatus("searching"); onSound("tap"); socket.current.emit("joinQueue", queue); }
  function leave() { socket.current?.emit("next"); setStatus("ready"); setShared([]); }
  function next() { if (!socket.current?.connected) return; setMessages([]); setShared([]); setStatus("searching"); socket.current.emit("next"); socket.current.emit("joinQueue", queue); }
  function send() { const body = draft.trim(); if (!body || !matched) return; const outgoing: ChatMessage = { clientMessageId: crypto.randomUUID(), body }; socket.current?.emit("message", outgoing); setMessages((current) => [...current, { id: outgoing.clientMessageId, body, mine: true }]); setDraft(""); onSound("send"); }
  return <div className="match-page page-enter"><header className="content-head content-head--compact"><div><p className="overline">DROP IN · TEXT</p><h1>{matched ? `You met ${currentPeer.name}.` : matching ? "Scanning the rain." : "Start a small, random thing."}</h1></div><div className={status === "offline" ? "connection-badge connection-badge--offline" : "connection-badge"}><i />{status === "offline" ? "Reconnecting" : "Secure text"}</div></header><div className="match-layout"><aside className="match-settings"><div className="match-settings__head"><span>Match settings</span><PlanPill plan={profile.plan} /></div><label>Interests <small>up to 5</small></label><div className="inline-input"><input value={interestDraft} onChange={(event) => setInterestDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterest(); } }} placeholder="music, art, gaming" disabled={matching || matched} /><button onClick={addInterest} disabled={!interestDraft.trim() || matching || matched}>Add</button></div><div className="chips">{queue.interests.map((interest) => <button className="chip" key={interest} disabled={matching || matched} onClick={() => setQueue({ ...queue, interests: queue.interests.filter((item) => item !== interest) })}>{interest}<span>×</span></button>)}</div><label>Language</label><button className={lockedLanguage ? "filter-select filter-select--locked" : "filter-select"} onClick={() => { if (lockedLanguage) onUpgrade("plus", "Language matching begins with Rain Plus."); }}><span>{lockedLanguage ? "Any language" : queue.language === "en" ? "English" : queue.language}</span>{lockedLanguage ? <Icon name="lock" size={14} /> : <select value={queue.language} onChange={(event) => setQueue({ ...queue, language: event.target.value })}><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="pt">Portuguese</option></select>}</button><label>Who you meet</label><button className={lockedGender ? "filter-select filter-select--locked" : "filter-select"} onClick={() => { if (lockedGender) onUpgrade("plus", "Gender preferences begin with Rain Plus."); }}><span>{lockedGender ? "Everyone" : profile.seeking}</span>{lockedGender ? <Icon name="lock" size={14} /> : <Icon name="user" size={14} />}</button><p className="match-settings__note"><Icon name="lock" size={13} /> Random chats stay temporary unless you both decide otherwise.</p></aside><section className="random-room"><header className="random-room__head"><div><span className="overline">{matched ? "MATCHED" : "TEMPORARY ROOM"}</span><h2>{matched ? currentPeer.name : matching ? "Finding someone…" : status === "peer-left" ? "They left the room" : "Your next chat starts here"}</h2></div>{matched && <div className="room-actions"><button onClick={() => onAddFriend(currentPeer.id)} title="Add friend"><Icon name="user" size={16} /><span>Add friend</span></button><button onClick={() => onVouch(currentPeer.id)} title="Give karma"><Icon name="spark" size={16} /><span>Vouch</span></button><button onClick={() => socket.current?.emit("reportPeer", { reason: "other" })}>Report</button></div>}</header>{matched && <div className="peer-strip"><Avatar member={currentPeer} size="md" /><div><strong>{currentPeer.name}</strong><span>@{currentPeer.handle} · {currentPeer.karma} Rain score</span></div>{shared.length ? <p>You both like <b>{shared.join(" · ")}</b></p> : <p>Keep it kind. The room is private and temporary.</p>}</div>}<div className="random-messages" aria-live="polite">{!matched ? <div className="room-empty"><div className={matching ? "room-empty__orb room-empty__orb--searching" : "room-empty__orb"}><RainLogo compact /></div><h3>{matching ? "Looking for a shared signal" : "Leave expectations at the door."}</h3><p>{matching ? "Rain is looking for an available person with something in common." : "No transcript is saved from a random chat. Share only what feels right."}</p></div> : messages.length ? messages.map((message) => <p className={message.mine ? "bubble bubble--mine" : "bubble"} key={message.id}>{message.body}</p>) : <div className="conversation-prompt"><span>Say hello</span><p>Start simple: “What brought you here tonight?”</p></div>}</div>{matched ? <div className="room-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Write something real…" maxLength={1000} /><button className="button button--light" disabled={!draft.trim()} onClick={send}>Send <Icon name="arrow" size={15} /></button></div> : <div className="room-idle">{matching ? <button className="button button--ghost" onClick={() => { socket.current?.emit("leaveQueue"); setStatus("ready"); }}>Cancel search</button> : <button className="button button--light" disabled={status === "offline"} onClick={begin}>{status === "peer-left" ? "Find someone new" : "Find a text match"}<Icon name="arrow" size={16} /></button>}</div>}{matched && <footer className="room-footer"><button className="button button--ghost" onClick={leave}>Leave chat</button><button className="button button--light" onClick={next}>Next person <Icon name="arrow" size={16} /></button></footer>}</section></div></div>;
}

function MediaMatch({ kind, profile, onUpgrade, onNotice, onSound }: { kind: "voice" | "video"; profile: Profile; onUpgrade: (required: Plan, message: string) => boolean; onNotice: (message: string) => void; onSound: (sound: Sound) => void }) {
  const [state, setState] = useState<MediaState>("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const stream = useRef<MediaStream | null>(null); const context = useRef<AudioContext | null>(null); const animation = useRef<number | null>(null); const video = useRef<HTMLVideoElement | null>(null);
  const isVideo = kind === "video"; const title = isVideo ? "See the moment." : "Hear the moment.";
  function stopPreview() { if (animation.current) cancelAnimationFrame(animation.current); animation.current = null; stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; void context.current?.close(); context.current = null; if (video.current) video.current.srcObject = null; setMuted(false); setLevel(0); setState("idle"); }
  useEffect(() => () => stopPreview(), []);
  async function startPreview() { if (!navigator.mediaDevices?.getUserMedia) { setState("unsupported"); return; } setState("requesting"); try { const next = await navigator.mediaDevices.getUserMedia(isVideo ? { video: { facingMode: "user" }, audio: { echoCancellation: true, noiseSuppression: true } } : { audio: { echoCancellation: true, noiseSuppression: true } }); stream.current = next; if (isVideo && video.current) { video.current.srcObject = next; await video.current.play(); } const audio = new AudioContext(); const analyser = audio.createAnalyser(); analyser.fftSize = 256; audio.createMediaStreamSource(next).connect(analyser); context.current = audio; const samples = new Uint8Array(analyser.fftSize); const sample = () => { analyser.getByteTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, item) => sum + ((item - 128) / 128) ** 2, 0) / samples.length); setLevel(Math.min(1, rms * 6)); animation.current = requestAnimationFrame(sample); }; sample(); setState("previewing"); onSound("tap"); } catch { setState("blocked"); } }
  function toggleMute() { const next = !muted; stream.current?.getAudioTracks().forEach((track) => { track.enabled = !next; }); setMuted(next); }
  function join() { if (!onUpgrade("plus", `${isVideo ? "Video" : "Voice"} matching starts with Rain Plus.`)) return; onNotice(`${isVideo ? "Video" : "Voice"} match flow is ready on the frontend. Connect WebRTC room tokens and media permissions in the realtime backend to take people live.`); }
  const helper = state === "requesting" ? "Waiting for permission…" : state === "blocked" ? `Allow ${isVideo ? "camera and microphone" : "microphone"} access in your browser, then try again.` : state === "unsupported" ? "This browser cannot access media devices." : state === "previewing" ? "You are in control. Your media is only a local preview until you join a match." : `Preview your ${isVideo ? "camera and microphone" : "microphone"} before you meet anyone.`;
  return <div className="media-page page-enter"><header className="content-head content-head--compact"><div><p className="overline">DROP IN · {isVideo ? "VIDEO" : "VOICE"}</p><h1>{title} <em>Keep control.</em></h1><p>{helper}</p></div><PlanPill plan={profile.plan} /></header><section className={`media-stage media-stage--${kind}`}><div className="media-stage__ambient media-stage__ambient--one" /><div className="media-stage__ambient media-stage__ambient--two" />{isVideo ? <div className="camera-preview">{state === "previewing" ? <video ref={video} muted playsInline /> : <div className="camera-preview__empty"><Icon name="video" size={28} /><span>Camera preview</span></div>}<div className="camera-preview__label"><i />{state === "previewing" ? "Preview live · only you can see this" : "Camera off"}</div></div> : <div className="voice-stage"><div className="voice-stage__orb" style={{ "--voice-level": muted ? 0 : level } as CSSProperties}>{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}<div><Icon name="mic" size={32} /></div></div><div className="voice-stage__peer"><span /><i>⌁</i><span /></div><div className="voice-stage__orb voice-stage__orb--peer" style={{ "--voice-level": state === "previewing" ? .3 : .08 } as CSSProperties}>{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}<div><Icon name="mic" size={29} /></div></div><div className="media-person media-person--you"><strong>You</strong><span>{muted ? "Muted" : state === "previewing" ? "Listening" : "Mic off"}</span></div><div className="media-person media-person--peer"><strong>Someone new</strong><span>Waiting to match</span></div></div>}<div className="media-controls">{state === "previewing" && <button className={muted ? "round-control round-control--muted" : "round-control"} onClick={toggleMute} aria-label="Toggle microphone"><Icon name="mic" size={18} /></button>}{state === "previewing" ? <button className="button button--ghost" onClick={stopPreview}>Stop preview</button> : <button className="button button--light" onClick={() => void startPreview()} disabled={state === "requesting" || state === "unsupported"}>Test {isVideo ? "camera" : "microphone"} <Icon name={isVideo ? "video" : "mic"} size={16} /></button>}<button className="button button--outline" onClick={join}>Find a {kind} match <Icon name="arrow" size={16} /></button></div><p className="media-stage__privacy"><Icon name="lock" size={13} /> No one can hear or see you until you explicitly join a match.</p></section><section className="media-rules"><span><Icon name="spark" size={16} /> Subtle reactive signal</span><span><Icon name="lock" size={16} /> Explicit media controls</span><span><Icon name="message" size={16} /> One-to-one and temporary</span></section></div>;
}

function Circles({ profile, messages, onSend, onSound }: { profile: Profile; messages: Record<string, GroupMessage[]>; onSend: (channelId: string, body: string) => void; onSound: (sound: Sound) => void }) {
  const [active, setActive] = useState(channels[0].id); const [draft, setDraft] = useState(""); const channel = channels.find((item) => item.id === active)!;
  function send() { const body = draft.trim(); if (!body) return; onSend(active, body); setDraft(""); }
  return <div className="circles-page page-enter"><header className="content-head content-head--compact"><div><p className="overline">CIRCLES · LIVE ROOMS</p><h1>Find your <em>people.</em></h1><p>Circles are live public spaces. Stay for a message or settle into the conversation.</p></div><button className="button button--outline" onClick={() => onSound("notice")}><Icon name="plus" size={16} />Create a Circle</button></header><div className="circles-layout"><aside className="circle-list"><p className="sidebar-label">CHANNELS</p>{channels.map((item) => <button key={item.id} className={item.id === active ? "circle-list__item circle-list__item--active" : "circle-list__item"} onClick={() => { setActive(item.id); onSound("tap"); }}><span>#</span><div><strong>{item.name}</strong><small>{item.description}</small></div>{item.live && <i />}</button>)}<div className="circle-list__footer"><Icon name="users" size={17} /><span>{members.filter((member) => member.status === "online").length} people online now</span></div></aside><section className="circle-room"><header className="circle-room__head"><div><span># {channel.name}</span><p>{channel.description}</p></div><div><i className="live-dot" /> {channel.members} here</div></header><div className="circle-room__messages">{(messages[active] ?? []).map((message) => <div className={message.mine ? "group-message group-message--mine" : "group-message"} key={message.id}>{message.mine ? <Avatar profile={profile} size="sm" /> : <Avatar member={members.find((member) => member.name === message.author) ?? members[0]} size="sm" />}<div><strong>{message.mine ? profile.name : message.author}<small>{message.createdAt}</small></strong><p>{message.body}</p></div></div>)}</div><div className="circle-room__composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder={`Message #${channel.name}`} maxLength={600} /><button className="button button--light" onClick={send} disabled={!draft.trim()}>Send <Icon name="arrow" size={15} /></button></div></section><aside className="circle-people"><p className="sidebar-label">IN THIS CIRCLE · {channel.members}</p>{members.map((member) => <div className="member-row" key={member.id}><Avatar member={member} size="sm" /><div><strong>{member.name}</strong><span>{member.interests.slice(0, 2).join(" · ")}</span></div><i className={`presence presence--${member.status.replaceAll(" ", "-")}`} /></div>)}</aside></div></div>;
}

function Inbox({ profile, friends, dms, onSend, onRemove, onSound }: { profile: Profile; friends: Member[]; dms: DmThread[]; onSend: (memberId: string, body: string) => void; onRemove: (memberId: string) => void; onSound: (sound: Sound) => void }) {
  const [activeId, setActiveId] = useState<string | null>(() => friends[0]?.id ?? null); const [draft, setDraft] = useState(""); const active = friends.find((member) => member.id === activeId); const thread = dms.find((item) => item.memberId === activeId);
  useEffect(() => { if (!activeId && friends[0]) setActiveId(friends[0].id); if (activeId && !friends.some((member) => member.id === activeId)) setActiveId(friends[0]?.id ?? null); }, [activeId, friends]);
  function send() { if (!activeId || !draft.trim()) return; onSend(activeId, draft.trim()); setDraft(""); }
  return <div className="inbox-page page-enter">
    <header className="content-head content-head--compact"><div><p className="overline">INBOX · SAVED DMS</p><h1>Keep the good <em>ones.</em></h1><p>Only connections you choose to keep can appear here. Random room transcripts never do.</p></div></header>
    <div className="inbox-layout">
      <aside className="dm-list">
        <div className="dm-list__head"><span>Connections</span><button aria-label="New direct message"><Icon name="plus" size={16} /></button></div>
        {friends.length ? friends.map((member) => {
          const last = dms.find((item) => item.memberId === member.id)?.messages.at(-1);
          return <button className={member.id === activeId ? "dm-list__item dm-list__item--active" : "dm-list__item"} key={member.id} onClick={() => { setActiveId(member.id); onSound("tap"); }}><Avatar member={member} size="md" /><div><strong>{member.name}</strong><span>{last?.body ?? "Start your first saved message."}</span></div>{member.status === "online" && <i />}</button>;
        }) : <div className="dm-list__empty"><Icon name="users" size={25} /><p>When a random chat becomes a mutual connection, it appears here.</p></div>}
      </aside>
      <section className="dm-room">{active ? <>
        <header className="dm-room__head"><Avatar member={active} size="md" /><div><strong>{active.name}</strong><span>{active.status === "online" ? "Online now" : active.status} · @{active.handle}</span></div><button className="icon-button" title="Remove friend" onClick={() => onRemove(active.id)}><Icon name="more" size={18} /></button></header>
        <div className="dm-room__messages">{thread?.messages.map((message) => <p className={message.from === "me" ? "bubble bubble--mine" : "bubble"} key={message.id}>{message.body}<small>{message.createdAt}</small></p>)}{!thread?.messages.length && <div className="room-empty"><div className="room-empty__orb"><Avatar member={active} size="md" /></div><h3>Keep it going.</h3><p>This DM is saved in this browser until accounts and secure server-side storage are connected.</p></div>}</div>
        <div className="room-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder={`Message ${active.name}`} maxLength={1000} /><button className="button button--light" onClick={send} disabled={!draft.trim()}>Send <Icon name="arrow" size={15} /></button></div>
      </> : <div className="inbox-empty"><RainLogo /><h2>Your inbox is waiting.</h2><p>Friends you both agree to keep will appear here.</p></div>}</section>
      <aside className="dm-profile"><Avatar member={active ?? members[0]} size="lg" /><strong>{active?.name ?? "Connections"}</strong>{active ? <><span>@{active.handle}</span><PlanPill plan="free" /><p>{active.interests.join(" · ")}</p><div><Icon name="spark" size={15} />{active.karma} Rain score</div></> : <p>Saved conversations are for mutual connections only.</p>}</aside>
    </div>
  </div>;
}

function ProfileView({ profile, onChange, onUpgrade }: { profile: Profile; onChange: (patch: Partial<Profile>) => void; onUpgrade: () => void }) {
  const [editing, setEditing] = useState(false); const [name, setName] = useState(profile.name); const [bio, setBio] = useState(profile.bio);
  useEffect(() => { setName(profile.name); setBio(profile.bio); }, [profile]);
  async function readAvatar(file?: File) { if (!file || !file.type.startsWith("image/") || file.size > 900_000) return; const result = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); onChange({ avatar: result }); }
  return <div className="profile-page page-enter"><header className="content-head content-head--compact"><div><p className="overline">PROFILE · YOUR SIGNAL</p><h1>Make it feel like <em>you.</em></h1><p>Your profile is visible only to saved connections and the people you choose to meet.</p></div><button className="button button--outline" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit profile"}</button></header><section className="profile-card"><div className="profile-card__top"><label className={editing ? "profile-avatar-edit" : "profile-avatar-edit profile-avatar-edit--static"}><Avatar profile={profile} size="lg" />{editing && <span><Icon name="camera" size={15} />Change</span>}<input disabled={!editing} type="file" accept="image/*" onChange={(event) => void readAvatar(event.target.files?.[0])} /></label><div>{editing ? <input className="profile-name-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /> : <h2>{profile.name}</h2>}<span>@rainfall · joined {new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(profile.createdAt))}</span><PlanPill plan={profile.plan} /></div><div className="profile-score"><Icon name="spark" size={18} /><strong>{profile.plan === "free" ? "—" : profile.karma}</strong><span>Rain score</span></div></div><div className="profile-card__body"><div><p className="sidebar-label">ABOUT</p>{editing ? <textarea value={bio} onChange={(event) => setBio(event.target.value)} placeholder="A few words about you" maxLength={120} /> : <p>{profile.bio || "No bio yet. A small detail makes a connection easier to start."}</p>}{editing && <button className="button button--light" onClick={() => { onChange({ name: name.trim() || profile.name, bio: bio.trim() }); setEditing(false); }}>Save changes <Icon name="check" size={15} /></button>}</div><div><p className="sidebar-label">MATCH PREFERENCES</p><dl><div><dt>I am</dt><dd>{profile.identity}</dd></div><div><dt>Looking for</dt><dd>{profile.plan === "free" ? <button onClick={onUpgrade}>Unlock with Plus <Icon name="lock" size={12} /></button> : profile.seeking}</dd></div><div><dt>Interests</dt><dd>{profile.interests.length ? profile.interests.join(" · ") : "Open to chance"}</dd></div></dl></div><div><p className="sidebar-label">SOUND FEEDBACK</p><button className={profile.soundEnabled ? "sound-toggle sound-toggle--on" : "sound-toggle"} onClick={() => onChange({ soundEnabled: !profile.soundEnabled })}><span><Icon name="volume" size={17} />Subtle sounds</span><i /></button><p className="field-note">Short, quiet feedback for actions, messages, and a new match. Never plays automatically on arrival.</p></div></div></section><section className="profile-upgrade"><div><PlanPill plan={profile.plan} /><h3>{profile.plan === "free" ? "Shape your forecast with Rain Plus." : profile.plan === "plus" ? "Build trust with Rain Pro." : "You have the full Rain forecast."}</h3><p>{profile.plan === "free" ? "Unlock gender and language matching, plus voice and video drop-ins." : profile.plan === "plus" ? "Use Rain score controls and advanced trust preferences." : "Thank you for helping keep Rain kind."}</p></div>{profile.plan !== "pro" && <button className="button button--light" onClick={onUpgrade}>View membership <Icon name="arrow" size={16} /></button>}</section></div>;
}

function Plans({ profile, onSelect }: { profile: Profile; onSelect: (plan: Plan) => void }) {
  const plans: { id: Plan; name: string; eyebrow: string; price: string; description: string; features: string[]; featured?: boolean }[] = [
    { id: "free", name: "Free", eyebrow: "Try the rain", price: "$0", description: "A calm place to start meeting someone new.", features: ["Random text chat", "Interest matching", "Browse live Circles", "Temporary random rooms"] },
    { id: "plus", name: "Rain Plus", eyebrow: "Shape the forecast", price: "$7", description: "More ways to find a conversation that fits.", features: ["Everything in Free", "Gender match preferences", "Language matching", "Voice and video matching", "Expanded interest filters"], featured: true },
    { id: "pro", name: "Rain Pro", eyebrow: "Build better signals", price: "$14", description: "More context and control for regular Rain people.", features: ["Everything in Plus", "Rain score and trust filters", "Advanced match pacing", "Priority live-Circle discovery", "Early feature access"] },
  ];
  return <div className="plans-page page-enter"><header className="plans-hero"><p className="overline">MEMBERSHIP · CHOOSE YOUR FORECAST</p><h1>More control,<br /><em>never more noise.</em></h1><p>Everyone can meet someone new for free. Membership adds matching controls—not a different standard of kindness.</p></header><div className="plan-grid">{plans.map((plan) => <article className={plan.featured ? "plan-card plan-card--featured" : "plan-card"} key={plan.id}>{plan.featured && <span className="plan-card__flag">Most balanced</span>}<p className="overline">{plan.eyebrow}</p><h2>{plan.name}</h2><p className="plan-card__price"><strong>{plan.price}</strong>{plan.id !== "free" && <span>/ month</span>}</p><p>{plan.description}</p><ul>{plan.features.map((feature) => <li key={feature}><Icon name="check" size={15} />{feature}</li>)}</ul><button className={profile.plan === plan.id ? "button button--ghost" : plan.featured ? "button button--light" : "button button--outline"} onClick={() => onSelect(plan.id)}>{profile.plan === plan.id ? "Current plan" : plan.id === "free" ? "Use Free" : `Choose ${plan.name}`} {profile.plan !== plan.id && <Icon name="arrow" size={15} />}</button></article>)}</div><p className="plans-footnote"><Icon name="lock" size={14} /> This is the frontend membership flow. Before taking payment, connect authenticated accounts, Stripe Checkout, entitlement webhooks, and server-side match enforcement.</p></div>;
}

export default App;
