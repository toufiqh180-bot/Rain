import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, ClientToServerEvents, QueuePreferences, ServerToClientEvents } from "@rain/protocol";
import Landing from "./Landing";
import {
  ApiError,
  auth,
  billing,
  circles as circlesApi,
  isApiConfigured,
  isRealtimeConfigured,
  media,
  onUnauthorized,
  profiles,
  realtime,
  realtimeEndpoint,
  safety,
  social,
} from "./api";
import type {
  Circle,
  CircleMessage,
  Connection,
  DirectMessage,
  DirectThread,
  Entitlement,
  Plan,
  Profile,
  Session,
} from "./types";

type Stage = "landing" | "auth" | "onboarding" | "app";
type Section = "forecast" | "text" | "voice" | "video" | "circles" | "inbox" | "profile" | "membership" | "settings";
type MatchStatus = "offline" | "ready" | "searching" | "matched" | "peer-left";
type MediaState = "idle" | "requesting" | "previewing" | "blocked" | "unsupported";
type Sound = "tap" | "match" | "send" | "notice";
type RainSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The only thing this browser is allowed to remember on its own. */
const soundKey = "rain.device.sound";

function readSoundPreference() {
  try {
    return window.localStorage.getItem(soundKey) !== "off";
  } catch {
    return true;
  }
}

function messageFor(reason: unknown) {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "Something went wrong.";
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "R";
}

function clockTime(iso: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(parsed);
}

/* ---------------------------------------------------------------- shared -- */

function RainLogo({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={compact ? "rain-mark rain-mark--compact" : "rain-mark"} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M18 39.5h27.2a10.8 10.8 0 0 0 1-21.5A15.2 15.2 0 0 0 17.3 23 8.4 8.4 0 0 0 18 39.5Z" />
      <path d="m23 46-2 6m12-6-2 6m12-6-2 6" />
    </svg>
  );
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
    case "card": return <svg {...shared}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></svg>;
    case "exit": return <svg {...shared}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
    case "camera": return <svg {...shared}><path d="M4 8h4l1.5-2h5L16 8h4v11H4Z" /><circle cx="12" cy="13" r="3.2" /></svg>;
    case "volume": return <svg {...shared}><path d="M4 10h4l5-4v12l-5-4H4Z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></svg>;
    default: return <svg {...shared}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

/**
 * A circle, always. `aspect-ratio` plus a fixed basis stops a flex or grid
 * parent from stretching the avatar into an ellipse.
 */
function Avatar({ name, avatarUrl, size = "md" }: { name: string; avatarUrl?: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {avatarUrl ? <img src={avatarUrl} alt="" loading="lazy" /> : initials(name)}
    </span>
  );
}

function PlanPill({ plan }: { plan: Plan }) {
  return <span className={`plan-pill plan-pill--${plan}`}>{plan === "free" ? "Free" : plan === "plus" ? "Plus" : "Pro"}</span>;
}

function Empty({ icon, title, action }: { icon: string; title: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={24} />
      <p>{title}</p>
      {action}
    </div>
  );
}

/** Shown wherever a screen needs a service this deployment has not connected. */
function ServiceGap({ label }: { label: string }) {
  return (
    <div className="empty empty--gap">
      <Icon name="lock" size={22} />
      <p>{label} is not connected in this environment.</p>
    </div>
  );
}

type Resource<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** Loads server state with abort-on-unmount and an explicit not-configured path. */
function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isApiConfigured);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!isApiConfigured) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    loaderRef.current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((reason) => {
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(messageFor(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: useCallback(() => setNonce((value) => value + 1), []) };
}

/* ------------------------------------------------------------------- app -- */

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>("landing");
  const [booting, setBooting] = useState(isApiConfigured);

  // Restore the session from the HttpOnly cookie so a refresh keeps you signed in.
  useEffect(() => {
    if (!isApiConfigured) return;
    const controller = new AbortController();
    auth
      .session(controller.signal)
      .then((restored) => {
        if (controller.signal.aborted || !restored) return;
        setSession(restored);
        setStage(restored.profile ? "app" : "onboarding");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, []);

  // A rejected session anywhere in the app returns the whole client to signed out.
  useEffect(
    () =>
      onUnauthorized(() => {
        setSession(null);
        setStage("landing");
      }),
    [],
  );

  const signOut = useCallback(async () => {
    // Revoke server-side first. Only then does the client forget anything —
    // otherwise the UI would look signed out while the session stayed valid.
    await auth.signOut();
    setSession(null);
    setStage("landing");
    window.scrollTo(0, 0);
  }, []);

  if (booting) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <RainLogo />
      </div>
    );
  }

  if (stage === "landing") {
    return <Landing onEnter={() => setStage("auth")} onSignIn={() => setStage("auth")} />;
  }

  if (stage === "auth") {
    return (
      <Auth
        onBack={() => setStage("landing")}
        onAuthenticated={(next) => {
          setSession(next);
          setStage(next.profile ? "app" : "onboarding");
        }}
      />
    );
  }

  if (stage === "onboarding" || !session?.profile) {
    return (
      <Onboarding
        onBack={() => void signOut().catch(() => setStage("landing"))}
        onComplete={(profile) => {
          setSession((current) => (current ? { ...current, profile } : current));
          setStage("app");
        }}
      />
    );
  }

  return (
    <Workspace
      session={session}
      onProfileChange={(profile) => setSession((current) => (current ? { ...current, profile } : current))}
      onSignOut={signOut}
    />
  );
}

/* ------------------------------------------------------------------ auth -- */

function Auth({ onBack, onAuthenticated }: { onBack: () => void; onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return setError("Enter a valid email address.");
    if (password.length < 12) return setError("Use at least 12 characters.");
    if (mode === "signup" && password !== confirmPassword) return setError("Passwords do not match.");
    if (mode === "signup" && !accepted) return setError("Confirm you are 18 or older.");

    setSubmitting(true);
    try {
      const session =
        mode === "signup"
          ? await auth.signUp({ email: normalized, password, acceptedTerms: accepted })
          : await auth.signIn({ email: normalized, password });
      // Clear the secrets from component state the moment they are no longer needed.
      setPassword("");
      setConfirmPassword("");
      onAuthenticated(session);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth">
      <header className="auth__nav">
        <button className="brand brand--button" onClick={onBack}>
          <RainLogo />
          <span>rain</span>
        </button>
        <button className="text-link text-link--button" onClick={onBack}>Back</button>
      </header>

      <section className="auth__card">
        <h1>{mode === "signup" ? <>Enter <em>Rain.</em></> : <>Welcome <em>back.</em></>}</h1>

        <div className="auth__tabs" role="tablist">
          <button role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : undefined} onClick={() => { setMode("signup"); setError(null); }}>Create account</button>
          <button role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "is-active" : undefined} onClick={() => { setMode("signin"); setError(null); }}>Sign in</button>
        </div>

        <form onSubmit={(event) => void submit(event)} noValidate>
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />

          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" required minLength={12} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="12+ characters" />

          {mode === "signup" && (
            <>
              <label htmlFor="auth-confirm">Confirm password</label>
              <input id="auth-confirm" type="password" required minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat password" />
              <label className="auth__accept">
                <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                <span>I am 18 or older and accept the Terms and Privacy Policy.</span>
              </label>
            </>
          )}

          {error && <p className="auth__error" role="alert">{error}</p>}

          <button className="button button--light" type="submit" disabled={submitting}>
            {submitting ? "Please wait" : mode === "signup" ? "Create account" : "Sign in"}
            <Icon name="arrow" size={16} />
          </button>
        </form>

        {mode === "signin" && (
          <button
            className="auth__reset"
            onClick={() => {
              const target = email.trim().toLowerCase();
              if (!target) return setError("Enter your email first.");
              void auth
                .requestPasswordReset(target)
                .then(() => setError("If that email has an account, a reset link is on its way."))
                .catch((reason) => setError(messageFor(reason)));
            }}
          >
            Forgot password
          </button>
        )}
      </section>
    </main>
  );
}

/* ------------------------------------------------------------ onboarding -- */

const IDENTITY_CHOICES = ["Woman", "Man", "Nonbinary", "Prefer not to say"];
const SEEKING_CHOICES = ["Everyone", "Women", "Men", "Nonbinary people"];

function Onboarding({ onComplete, onBack }: { onComplete: (profile: Profile) => void; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [genderIdentity, setGenderIdentity] = useState(IDENTITY_CHOICES[3]);
  const [seeking, setSeeking] = useState(SEEKING_CHOICES[0]);
  const [interests, setInterests] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const steps = ["You", "Match", "Interests"];

  // A blob URL is a resource, not a string. Revoke it when it is replaced.
  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

  function pickAvatar(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Choose an image file.");
    if (file.size > 4_000_000) return setError("Images must be under 4 MB.");
    setError(null);
    setAvatarFile(file);
    setAvatarPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  }

  function addInterest() {
    const value = draft.trim().toLowerCase();
    if (!value || interests.includes(value) || interests.length >= 5) return;
    setInterests([...interests, value]);
    setDraft("");
  }

  async function finish() {
    setError(null);
    setSaving(true);
    try {
      let profile = await profiles.create({
        name: name.trim(),
        bio: bio.trim(),
        identity: genderIdentity,
        seeking,
        interests,
        acceptedAgeGate: accepted,
      });
      // The avatar is a second call on purpose: the profile exists even if the
      // upload fails, so nobody gets stranded mid-signup by a storage hiccup.
      if (avatarFile) {
        const { avatarUrl } = await profiles.uploadAvatar(avatarFile);
        profile = { ...profile, avatarUrl };
      }
      onComplete(profile);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }

  const canContinue = step === 0 ? name.trim().length >= 2 : step === 2 ? accepted : true;

  return (
    <main className="onboarding">
      <header className="onboarding__header">
        <button className="brand brand--button" onClick={onBack}>
          <RainLogo />
          <span>rain</span>
        </button>
      </header>

      <div className="onboarding__progress">
        {steps.map((label, index) => (
          <div key={label} className={index <= step ? "onboarding-step onboarding-step--active" : "onboarding-step"}>
            <i>{index < step ? <Icon name="check" size={12} /> : index + 1}</i>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <section className="onboarding-card">
        {step === 0 && (
          <div className="flow-step">
            <h1>Make it feel like <em>you.</em></h1>
            <div className="profile-picker">
              <label className="avatar-upload">
                <Avatar name={name || "You"} avatarUrl={avatarPreview} size="lg" />
                <span className="avatar-upload__badge"><Icon name="camera" size={15} /> Photo</span>
                <input type="file" accept="image/*" onChange={(event) => pickAvatar(event.target.files?.[0])} />
              </label>
              <div>
                <label htmlFor="profile-name">Display name</label>
                <input id="profile-name" autoFocus maxLength={24} value={name} onChange={(event) => setName(event.target.value)} />
                <label htmlFor="profile-bio">Bio <span>optional</span></label>
                <textarea id="profile-bio" maxLength={120} value={bio} onChange={(event) => setBio(event.target.value)} />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flow-step">
            <h1>Who would you like to <em>meet?</em></h1>
            <div className="choice-block">
              <span>You are</span>
              <div className="choice-grid">
                {IDENTITY_CHOICES.map((choice) => (
                  <button key={choice} className={genderIdentity === choice ? "choice choice--selected" : "choice"} onClick={() => setGenderIdentity(choice)}>
                    {choice}{genderIdentity === choice && <Icon name="check" size={15} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="choice-block">
              <span>Looking for</span>
              <div className="choice-grid">
                {SEEKING_CHOICES.map((choice) => (
                  <button key={choice} className={seeking === choice ? "choice choice--selected" : "choice"} onClick={() => setSeeking(choice)}>
                    {choice}{seeking === choice && <Icon name="check" size={15} />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flow-step">
            <h1>What pulls you <em>in?</em></h1>
            <div className="interest-builder">
              <div>
                <input value={draft} maxLength={32} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterest(); } }} placeholder="Add up to five" />
                <button onClick={addInterest} disabled={!draft.trim()}>Add</button>
              </div>
              <div className="chips chips--large">
                {interests.map((interest) => (
                  <button className="chip" key={interest} onClick={() => setInterests(interests.filter((item) => item !== interest))}>
                    {interest}<span>×</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="safety-check">
              <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
              <span>I am 18 or older and agree to keep Rain respectful.</span>
            </label>
          </div>
        )}

        {error && <p className="auth__error" role="alert">{error}</p>}

        <div className="flow-actions">
          <button className="button button--ghost" onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>Back</button>
          {step < 2 ? (
            <button className="button button--light" disabled={!canContinue} onClick={() => setStep(step + 1)}>Continue <Icon name="arrow" size={16} /></button>
          ) : (
            <button className="button button--light" disabled={!canContinue || saving} onClick={() => void finish()}>
              {saving ? "Saving" : "Enter Rain"} <Icon name="arrow" size={16} />
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------- workspace -- */

const NAV: { id: Section; icon: string; label: string }[] = [
  { id: "forecast", icon: "spark", label: "Forecast" },
  { id: "text", icon: "message", label: "Text" },
  { id: "voice", icon: "mic", label: "Voice" },
  { id: "video", icon: "video", label: "Video" },
  { id: "circles", icon: "users", label: "Circles" },
  { id: "inbox", icon: "inbox", label: "Inbox" },
];

function Workspace({
  session,
  onProfileChange,
  onSignOut,
}: {
  session: Session;
  onProfileChange: (profile: Profile) => void;
  onSignOut: () => Promise<void>;
}) {
  const profile = session.profile!;
  const [section, setSection] = useState<Section>("forecast");
  const [notice, setNotice] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(readSoundPreference);
  const [signingOut, setSigningOut] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(soundKey, soundEnabled ? "on" : "off"); } catch { /* preferences are best effort */ }
  }, [soundEnabled]);

  // Entitlement is read from billing, never inferred from a click.
  const entitlement = useResource<Entitlement>((signal) => billing.entitlement(signal), []);
  const plan: Plan = entitlement.data?.plan ?? profile.plan;

  const playSound = useCallback(
    (sound: Sound) => {
      if (!soundEnabled) return;
      try {
        const context = audioContext.current ?? new AudioContext();
        audioContext.current = context;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const frequencies: Record<Sound, number> = { tap: 440, match: 587, send: 698, notice: 330 };
        oscillator.type = sound === "match" ? "sine" : "triangle";
        oscillator.frequency.setValueAtTime(frequencies[sound], context.currentTime);
        if (sound === "match") oscillator.frequency.linearRampToValueAtTime(880, context.currentTime + 0.12);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.025, context.currentTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (sound === "match" ? 0.32 : 0.12));
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + (sound === "match" ? 0.34 : 0.14));
      } catch { /* audio feedback never blocks a conversation */ }
    },
    [soundEnabled],
  );

  useEffect(() => () => { void audioContext.current?.close(); }, []);

  const go = useCallback((next: Section) => { playSound("tap"); setSection(next); }, [playSound]);

  /** Client-side gating is a courtesy. The gateway enforces the real rule. */
  const requirePlan = useCallback(
    (required: Exclude<Plan, "free">) => {
      const allowed = required === "plus" ? plan !== "free" : plan === "pro";
      if (allowed) return true;
      playSound("notice");
      setSection("membership");
      return false;
    },
    [plan, playSound],
  );

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (reason) {
      setNotice(messageFor(reason));
      setSigningOut(false);
    }
  }

  return (
    <main className="workspace">
      <aside className="rail">
        <div className="rail__brand">
          <RainLogo compact />
          <span>rain</span>
        </div>

        <nav className="rail__nav" aria-label="Rain">
          {NAV.map((item) => (
            <button key={item.id} className={section === item.id ? "rail__item rail__item--active" : "rail__item"} onClick={() => go(item.id)} aria-current={section === item.id}>
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="rail__foot">
          <button className={section === "membership" ? "rail__item rail__item--active" : "rail__item"} onClick={() => go("membership")}>
            <Icon name="card" size={18} />
            <span>Membership</span>
          </button>
          <button className={section === "settings" ? "rail__item rail__item--active" : "rail__item"} onClick={() => go("settings")}>
            <Icon name="settings" size={18} />
            <span>Settings</span>
          </button>

          <button className={section === "profile" ? "rail__me rail__me--active" : "rail__me"} onClick={() => go("profile")}>
            <Avatar name={profile.name} avatarUrl={profile.avatarUrl} size="md" />
            <span className="rail__me-text">
              <strong>{profile.name}</strong>
              <small>@{profile.handle}</small>
            </span>
            <PlanPill plan={plan} />
          </button>

          <button className="rail__signout" onClick={() => void handleSignOut()} disabled={signingOut}>
            <Icon name="exit" size={16} />
            <span>{signingOut ? "Signing out" : "Sign out"}</span>
          </button>
        </div>
      </aside>

      <section className="app-content">
        {section === "forecast" && <Forecast profile={profile} onNavigate={go} />}
        {section === "text" && <TextMatch profile={profile} plan={plan} onNotice={setNotice} onSound={playSound} />}
        {section === "voice" && <MediaMatch kind="voice" plan={plan} requirePlan={requirePlan} onNotice={setNotice} />}
        {section === "video" && <MediaMatch kind="video" plan={plan} requirePlan={requirePlan} onNotice={setNotice} />}
        {section === "circles" && <Circles profile={profile} onSound={playSound} onNotice={setNotice} />}
        {section === "inbox" && <Inbox profile={profile} onSound={playSound} onNotice={setNotice} />}
        {section === "profile" && <ProfileView profile={profile} plan={plan} onChange={onProfileChange} onNotice={setNotice} />}
        {section === "membership" && <Membership plan={plan} entitlement={entitlement} onNotice={setNotice} />}
        {section === "settings" && <Settings account={session.account} soundEnabled={soundEnabled} onSoundChange={setSoundEnabled} onNotice={setNotice} />}
      </section>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </main>
  );
}

/* -------------------------------------------------------------- forecast -- */

function Forecast({ profile, onNavigate }: { profile: Profile; onNavigate: (section: Section) => void }) {
  const modes: { id: Section; icon: string; title: string }[] = [
    { id: "text", icon: "message", title: "Text" },
    { id: "voice", icon: "mic", title: "Voice" },
    { id: "video", icon: "video", title: "Video" },
    { id: "circles", icon: "users", title: "Circles" },
  ];
  return (
    <div className="page page-enter">
      <header className="content-head">
        <h1>Hello, <em>{profile.name.split(" ")[0]}.</em></h1>
      </header>
      <div className="mode-grid">
        {modes.map((mode, index) => (
          <button key={mode.id} className="mode-card" onClick={() => onNavigate(mode.id)}>
            <span className="mode-card__number">0{index + 1}</span>
            <span className="mode-card__icon"><Icon name={mode.icon} size={20} /></span>
            <h3>{mode.title}</h3>
            <i><Icon name="arrow" size={15} /></i>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ text match -- */

function TextMatch({ profile, plan, onNotice, onSound }: { profile: Profile; plan: Plan; onNotice: (message: string) => void; onSound: (sound: Sound) => void }) {
  const socket = useRef<RainSocket | null>(null);
  const [status, setStatus] = useState<MatchStatus>("offline");
  const [queue, setQueue] = useState<QueuePreferences>({ language: "en", interests: profile.interests });
  const [interestDraft, setInterestDraft] = useState("");
  const [messages, setMessages] = useState<{ id: string; body: string; mine: boolean }[]>([]);
  const [draft, setDraft] = useState("");
  const [shared, setShared] = useState<string[]>([]);
  const [matchId, setMatchId] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isRealtimeConfigured) return;
    let client: RainSocket | null = null;
    let cancelled = false;

    // The socket presents a short-lived token, never the session cookie itself.
    void (async () => {
      let token: string | undefined;
      if (isApiConfigured) {
        try {
          token = (await realtime.token()).token;
        } catch (reason) {
          if (!cancelled) onNotice(messageFor(reason));
          return;
        }
      }
      if (cancelled) return;

      client = io(realtimeEndpoint, { transports: ["websocket"], reconnectionAttempts: 5, auth: token ? { token } : undefined });
      socket.current = client;
      client.on("connect", () => setStatus("ready"));
      client.on("disconnect", () => setStatus("offline"));
      client.on("queueJoined", () => setStatus("searching"));
      client.on("matched", (match) => {
        setMessages([]);
        setShared(match.sharedInterests);
        setMatchId(match.matchId);
        setStatus("matched");
        onSound("match");
      });
      client.on("message", (message) => setMessages((current) => [...current, { id: message.clientMessageId, body: message.body, mine: false }]));
      client.on("peerLeft", () => { setStatus("peer-left"); setShared([]); setMatchId(null); });
      client.on("queueError", (error) => onNotice(error.message));
    })();

    return () => {
      cancelled = true;
      client?.disconnect();
      socket.current = null;
    };
  }, [onNotice, onSound]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages.length]);

  const matching = status === "searching";
  const matched = status === "matched";

  function addInterest() {
    const value = interestDraft.trim().toLowerCase();
    if (!value || queue.interests.includes(value) || queue.interests.length >= 5) return;
    setQueue({ ...queue, interests: [...queue.interests, value] });
    setInterestDraft("");
  }

  function begin() {
    if (!socket.current?.connected) return onNotice("Not connected to the text gateway.");
    setMessages([]);
    setShared([]);
    setStatus("searching");
    onSound("tap");
    socket.current.emit("joinQueue", queue);
  }

  function stop() {
    socket.current?.emit("next");
    setStatus("ready");
    setShared([]);
    setMatchId(null);
  }

  function next() {
    if (!socket.current?.connected) return;
    setMessages([]);
    setShared([]);
    setMatchId(null);
    setStatus("searching");
    socket.current.emit("next");
    socket.current.emit("joinQueue", queue);
  }

  function send() {
    const body = draft.trim();
    if (!body || !matched) return;
    const outgoing: ChatMessage = { clientMessageId: crypto.randomUUID(), body };
    socket.current?.emit("message", outgoing);
    setMessages((current) => [...current, { id: outgoing.clientMessageId, body, mine: true }]);
    setDraft("");
    onSound("send");
  }

  function report() {
    socket.current?.emit("reportPeer", { reason: "other" });
    if (isApiConfigured && matchId) {
      void safety.report({ matchId, reason: "other" }).catch((reason) => onNotice(messageFor(reason)));
    }
    setStatus("ready");
    setMatchId(null);
    onNotice("Reported. The chat has ended.");
  }

  if (!isRealtimeConfigured) {
    return (
      <div className="page page-enter">
        <header className="content-head content-head--compact"><h1>Text.</h1></header>
        <ServiceGap label="The text gateway" />
      </div>
    );
  }

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact">
        <h1>{matched ? "Connected." : matching ? "Searching." : "Text."}</h1>
        <div className={status === "offline" ? "connection-badge connection-badge--offline" : "connection-badge"}>
          <i />{status === "offline" ? "Offline" : "Secure"}
        </div>
      </header>

      <div className="match-layout">
        <aside className="match-settings">
          <div className="match-settings__head"><span>Match</span><PlanPill plan={plan} /></div>

          <label>Interests</label>
          <div className="inline-input">
            <input value={interestDraft} disabled={matching || matched} onChange={(event) => setInterestDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addInterest(); } }} placeholder="Add" />
            <button onClick={addInterest} disabled={!interestDraft.trim() || matching || matched}><Icon name="plus" size={15} /></button>
          </div>
          <div className="chips">
            {queue.interests.map((interest) => (
              <button className="chip" key={interest} disabled={matching || matched} onClick={() => setQueue({ ...queue, interests: queue.interests.filter((item) => item !== interest) })}>
                {interest}<span>×</span>
              </button>
            ))}
          </div>

          <label htmlFor="queue-language">Language</label>
          <select id="queue-language" value={queue.language} disabled={plan === "free" || matching || matched} onChange={(event) => setQueue({ ...queue, language: event.target.value })}>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="pt">Português</option>
            <option value="de">Deutsch</option>
          </select>
          {plan === "free" && <p className="field-note"><Icon name="lock" size={12} /> Plus</p>}
        </aside>

        <section className="room">
          <header className="room__head">
            <h2>{matching ? "Finding a match" : status === "peer-left" ? "Chat ended" : matched ? "Connected" : "Ready"}</h2>
            {matched && <button className="report" onClick={report}>Report</button>}
          </header>

          {matched && shared.length > 0 && <div className="room__shared">{shared.join(" · ")}</div>}

          <div className="room__stream" ref={streamRef}>
            {messages.map((message) => (
              <p className={message.mine ? "bubble bubble--mine" : "bubble"} key={message.id}>{message.body}</p>
            ))}
            {!messages.length && (
              <div className="room__idle">
                <RainLogo />
                {matching && <span className="room__pulse" />}
              </div>
            )}
          </div>

          <div className="room__composer">
            <textarea
              value={draft}
              maxLength={1000}
              disabled={!matched}
              placeholder={matched ? "Message" : ""}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
            />
            <div className="room__actions">
              {matched ? (
                <>
                  <button className="button button--ghost" onClick={next}>Next</button>
                  <button className="button button--light" onClick={send} disabled={!draft.trim()}>Send <Icon name="arrow" size={15} /></button>
                </>
              ) : matching ? (
                <button className="button button--ghost" onClick={stop}>Cancel</button>
              ) : (
                <button className="button button--light" onClick={begin} disabled={status === "offline"}>Start <Icon name="arrow" size={15} /></button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- voice/video -- */

function MediaMatch({
  kind,
  plan,
  requirePlan,
  onNotice,
}: {
  kind: "voice" | "video";
  plan: Plan;
  requirePlan: (required: Exclude<Plan, "free">) => boolean;
  onNotice: (message: string) => void;
}) {
  const [state, setState] = useState<MediaState>("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [joining, setJoining] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const animation = useRef<number | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const isVideo = kind === "video";

  const stopPreview = useCallback(() => {
    if (animation.current) cancelAnimationFrame(animation.current);
    animation.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close();
    context.current = null;
    if (video.current) video.current.srcObject = null;
    setMuted(false);
    setLevel(0);
    setState("idle");
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  async function startPreview() {
    if (!navigator.mediaDevices?.getUserMedia) return setState("unsupported");
    setState("requesting");
    try {
      const constraints: MediaStreamConstraints = isVideo
        ? { video: { facingMode: "user" }, audio: { echoCancellation: true, noiseSuppression: true } }
        : { audio: { echoCancellation: true, noiseSuppression: true } };
      const next = await navigator.mediaDevices.getUserMedia(constraints);
      stream.current = next;
      if (isVideo && video.current) {
        video.current.srcObject = next;
        await video.current.play().catch(() => undefined);
      }
      const audio = new AudioContext();
      context.current = audio;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(next).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buffer);
        const average = buffer.reduce((total, value) => total + value, 0) / buffer.length;
        setLevel(Math.min(1, average / 96));
        animation.current = requestAnimationFrame(tick);
      };
      tick();
      setState("previewing");
    } catch {
      setState("blocked");
    }
  }

  function toggleMute() {
    const next = !muted;
    stream.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }

  async function join() {
    if (!requirePlan("plus")) return;
    setJoining(true);
    try {
      // Ask for a room token. The server decides whether a live room exists.
      await media.roomToken({ matchId: "pending", kind });
    } catch (reason) {
      onNotice(messageFor(reason));
    } finally {
      setJoining(false);
    }
  }

  const helper =
    state === "requesting" ? "Waiting for permission" :
    state === "blocked" ? `Allow ${isVideo ? "camera and microphone" : "microphone"} access, then try again` :
    state === "unsupported" ? "This browser cannot access media devices" :
    state === "previewing" ? "Local preview only" :
    "";

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact">
        <h1>{isVideo ? "Video." : "Voice."}</h1>
        <PlanPill plan={plan} />
      </header>

      <section className={`media-stage media-stage--${kind}`}>
        {isVideo ? (
          <div className="camera-preview">
            <video ref={video} muted playsInline autoPlay />
            {state !== "previewing" && <div className="camera-preview__idle"><Icon name="camera" size={26} /></div>}
          </div>
        ) : (
          <div className="voice-orb" style={{ "--level": level } as CSSProperties}>
            {Array.from({ length: 32 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}
            <div><Icon name="mic" size={26} /></div>
          </div>
        )}

        {helper && <p className="media-stage__helper">{helper}</p>}

        <div className="media-controls">
          {state === "previewing" ? (
            <>
              <button className="button button--ghost" onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>
              <button className="button button--ghost" onClick={stopPreview}>Stop</button>
              <button className="button button--light" onClick={() => void join()} disabled={joining}>{joining ? "Connecting" : "Join"} <Icon name="arrow" size={15} /></button>
            </>
          ) : (
            <button className="button button--light" onClick={() => void startPreview()} disabled={state === "requesting"}>
              {isVideo ? "Preview camera" : "Preview microphone"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- circles -- */

function Circles({ profile, onSound, onNotice }: { profile: Profile; onSound: (sound: Sound) => void; onNotice: (message: string) => void }) {
  const list = useResource<Circle[]>((signal) => circlesApi.list(signal), []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<CircleMessage[]>([]);

  const items = list.data ?? [];
  const active = items.find((item) => item.id === activeId) ?? items[0] ?? null;

  useEffect(() => {
    if (!activeId && items[0]) setActiveId(items[0].id);
  }, [activeId, items]);

  const feed = useResource(
    (signal) => (active ? circlesApi.messages(active.id, undefined, signal) : Promise.resolve({ items: [], nextCursor: null })),
    [active?.id],
  );

  useEffect(() => setPending([]), [active?.id]);

  const messages = useMemo(() => [...(feed.data?.items ?? []), ...pending], [feed.data, pending]);

  async function send() {
    const body = draft.trim();
    if (!body || !active) return;
    setSending(true);
    try {
      const sent = await circlesApi.send(active.id, { clientMessageId: crypto.randomUUID(), body });
      setPending((current) => [...current, sent]);
      setDraft("");
      onSound("send");
    } catch (reason) {
      onNotice(messageFor(reason));
    } finally {
      setSending(false);
    }
  }

  if (!isApiConfigured) {
    return (
      <div className="page page-enter">
        <header className="content-head content-head--compact"><h1>Circles.</h1></header>
        <ServiceGap label="Circles" />
      </div>
    );
  }

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact">
        <h1>{active ? `#${active.slug}` : "Circles."}</h1>
      </header>

      <div className="split split--circles">
        <aside className="split__list">
          {list.loading && <div className="split__hint">Loading</div>}
          {list.error && <div className="split__hint">{list.error}</div>}
          {!list.loading && !items.length && <div className="split__hint">No Circles yet</div>}
          {items.map((item) => (
            <button key={item.id} className={item.id === active?.id ? "list-row list-row--active" : "list-row"} onClick={() => { setActiveId(item.id); onSound("tap"); }}>
              <span className="list-row__hash">#</span>
              <span className="list-row__text"><strong>{item.slug}</strong><small>{item.memberCount}</small></span>
              {item.live && <i className="live-dot" />}
            </button>
          ))}
        </aside>

        <section className="room">
          {active ? (
            <>
              <div className="room__stream">
                {feed.loading && <div className="split__hint">Loading</div>}
                {messages.map((message) => (
                  <div className={message.authorId === profile.id ? "line line--mine" : "line"} key={message.id}>
                    <Avatar name={message.authorName} avatarUrl={message.authorAvatarUrl} size="sm" />
                    <div>
                      <strong>{message.authorName}<small>{clockTime(message.sentAt)}</small></strong>
                      <p>{message.body}</p>
                    </div>
                  </div>
                ))}
                {!feed.loading && !messages.length && <Empty icon="users" title="Nothing here yet" />}
              </div>
              <div className="room__composer">
                <textarea value={draft} maxLength={1000} placeholder={`Message #${active.slug}`} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
                <div className="room__actions">
                  <button className="button button--light" onClick={() => void send()} disabled={!draft.trim() || sending}>Send <Icon name="arrow" size={15} /></button>
                </div>
              </div>
            </>
          ) : (
            <Empty icon="users" title="No Circles yet" />
          )}
        </section>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- inbox -- */

function Inbox({ profile, onSound, onNotice }: { profile: Profile; onSound: (sound: Sound) => void; onNotice: (message: string) => void }) {
  const connections = useResource<Connection[]>((signal) => social.connections(signal), []);
  const threads = useResource<DirectThread[]>((signal) => social.threads(signal), []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<DirectMessage[]>([]);

  const people = connections.data ?? [];
  const active = people.find((person) => person.id === activeId) ?? people[0] ?? null;
  const thread = (threads.data ?? []).find((item) => item.connectionId === active?.id) ?? null;

  useEffect(() => {
    if (!activeId && people[0]) setActiveId(people[0].id);
  }, [activeId, people]);

  const feed = useResource(
    (signal) => (thread ? social.messages(thread.id, undefined, signal) : Promise.resolve({ items: [], nextCursor: null })),
    [thread?.id],
  );

  useEffect(() => setPending([]), [thread?.id]);

  const messages = useMemo(() => [...(feed.data?.items ?? []), ...pending], [feed.data, pending]);

  async function send() {
    const body = draft.trim();
    if (!body || !thread) return;
    setSending(true);
    try {
      const sent = await social.sendMessage(thread.id, { clientMessageId: crypto.randomUUID(), body });
      setPending((current) => [...current, sent]);
      setDraft("");
      onSound("send");
    } catch (reason) {
      onNotice(messageFor(reason));
    } finally {
      setSending(false);
    }
  }

  async function remove(connectionId: string) {
    try {
      await social.removeConnection(connectionId);
      connections.reload();
      threads.reload();
      setActiveId(null);
    } catch (reason) {
      onNotice(messageFor(reason));
    }
  }

  if (!isApiConfigured) {
    return (
      <div className="page page-enter">
        <header className="content-head content-head--compact"><h1>Inbox.</h1></header>
        <ServiceGap label="Direct messages" />
      </div>
    );
  }

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact"><h1>Inbox.</h1></header>

      <div className="split split--inbox">
        <aside className="split__list">
          {connections.loading && <div className="split__hint">Loading</div>}
          {connections.error && <div className="split__hint">{connections.error}</div>}
          {!connections.loading && !people.length && <div className="split__hint">No connections yet</div>}
          {people.map((person) => (
            <button key={person.id} className={person.id === active?.id ? "list-row list-row--active" : "list-row"} onClick={() => { setActiveId(person.id); onSound("tap"); }}>
              <Avatar name={person.name} avatarUrl={person.avatarUrl} size="md" />
              <span className="list-row__text">
                <strong>{person.name}</strong>
                <small>@{person.handle}</small>
              </span>
              {person.presence === "online" && <i className="live-dot" />}
            </button>
          ))}
        </aside>

        <section className="room">
          {active ? (
            <>
              <header className="room__head">
                <Avatar name={active.name} avatarUrl={active.avatarUrl} size="md" />
                <h2>{active.name}<small>@{active.handle}</small></h2>
                <button className="icon-button" onClick={() => void remove(active.id)} aria-label={`Remove ${active.name}`}><Icon name="more" size={18} /></button>
              </header>
              <div className="room__stream">
                {feed.loading && <div className="split__hint">Loading</div>}
                {messages.map((message) => (
                  <p className={message.authorId === profile.id ? "bubble bubble--mine" : "bubble"} key={message.id}>
                    {message.body}<small>{clockTime(message.sentAt)}</small>
                  </p>
                ))}
                {!feed.loading && !messages.length && <Empty icon="message" title="No messages yet" />}
              </div>
              <div className="room__composer">
                <textarea value={draft} maxLength={1000} placeholder={`Message ${active.name}`} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
                <div className="room__actions">
                  <button className="button button--light" onClick={() => void send()} disabled={!draft.trim() || sending || !thread}>Send <Icon name="arrow" size={15} /></button>
                </div>
              </div>
            </>
          ) : (
            <Empty icon="inbox" title="No connections yet" />
          )}
        </section>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- profile -- */

function ProfileView({
  profile,
  plan,
  onChange,
  onNotice,
}: {
  profile: Profile;
  plan: Plan;
  onChange: (profile: Profile) => void;
  onNotice: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(profile.name);
    setBio(profile.bio);
  }, [profile]);

  async function save() {
    setSaving(true);
    try {
      onChange(await profiles.update({ name: name.trim(), bio: bio.trim() }));
      setEditing(false);
    } catch (reason) {
      onNotice(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return onNotice("Choose an image file.");
    if (file.size > 4_000_000) return onNotice("Images must be under 4 MB.");
    try {
      const { avatarUrl } = await profiles.uploadAvatar(file);
      onChange({ ...profile, avatarUrl });
    } catch (reason) {
      onNotice(messageFor(reason));
    }
  }

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact">
        <h1>Profile.</h1>
        <button className="button button--outline" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
      </header>

      <section className="profile-card">
        <div className="profile-card__top">
          <label className="avatar-upload avatar-upload--inline">
            <Avatar name={profile.name} avatarUrl={profile.avatarUrl} size="lg" />
            <span className="avatar-upload__badge"><Icon name="camera" size={14} /></span>
            <input type="file" accept="image/*" onChange={(event) => void uploadAvatar(event.target.files?.[0])} />
          </label>
          <div className="profile-card__identity">
            <strong>{profile.name}</strong>
            <span>@{profile.handle}</span>
          </div>
          <PlanPill plan={plan} />
        </div>

        <div className="profile-card__body">
          {editing ? (
            <div className="profile-form">
              <label htmlFor="edit-name">Display name</label>
              <input id="edit-name" value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
              <label htmlFor="edit-bio">Bio</label>
              <textarea id="edit-bio" value={bio} maxLength={120} onChange={(event) => setBio(event.target.value)} />
              <button className="button button--light" onClick={() => void save()} disabled={saving || name.trim().length < 2}>{saving ? "Saving" : "Save"}</button>
            </div>
          ) : (
            <>
              <div className="profile-field"><span>Bio</span><p>{profile.bio || "—"}</p></div>
              <div className="profile-field"><span>Interests</span><p>{profile.interests.length ? profile.interests.join(" · ") : "—"}</p></div>
              <div className="profile-field"><span>Rain score</span><p>{profile.karma}</p></div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ membership -- */

const PLAN_ROWS: { id: Plan; name: string; features: string[] }[] = [
  { id: "free", name: "Free", features: ["Text matching", "Interest matching", "Circles"] },
  { id: "plus", name: "Plus", features: ["Voice and video", "Gender preferences", "Language matching"] },
  { id: "pro", name: "Pro", features: ["Trust filters", "Match pacing", "Priority discovery"] },
];

function Membership({ plan, entitlement, onNotice }: { plan: Plan; entitlement: Resource<Entitlement>; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState<Plan | "portal" | null>(null);

  async function checkout(target: Exclude<Plan, "free">) {
    setBusy(target);
    try {
      // Stripe owns the payment surface, and its webhook — not this click —
      // grants the entitlement.
      const { url } = await billing.startCheckout(target);
      window.location.assign(url);
    } catch (reason) {
      onNotice(messageFor(reason));
      setBusy(null);
    }
  }

  async function portal() {
    setBusy("portal");
    try {
      const { url } = await billing.openPortal();
      window.location.assign(url);
    } catch (reason) {
      onNotice(messageFor(reason));
      setBusy(null);
    }
  }

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact">
        <h1>Membership.</h1>
        {entitlement.data?.status === "active" && <button className="button button--outline" onClick={() => void portal()} disabled={busy === "portal"}>Manage</button>}
      </header>

      {!isApiConfigured ? (
        <ServiceGap label="Billing" />
      ) : (
        <div className="plan-grid">
          {PLAN_ROWS.map((row) => (
            <article key={row.id} className={row.id === plan ? "plan-card plan-card--current" : "plan-card"}>
              <h3>{row.name}</h3>
              <ul>{row.features.map((feature) => <li key={feature}><Icon name="check" size={13} />{feature}</li>)}</ul>
              {row.id === plan ? (
                <span className="plan-card__current">Current</span>
              ) : row.id === "free" ? null : (
                <button className="button button--light" onClick={() => void checkout(row.id as Exclude<Plan, "free">)} disabled={busy === row.id}>
                  {busy === row.id ? "Opening" : "Choose"} <Icon name="arrow" size={15} />
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- settings -- */

function Settings({
  account,
  soundEnabled,
  onSoundChange,
  onNotice,
}: {
  account: Session["account"];
  soundEnabled: boolean;
  onSoundChange: (value: boolean) => void;
  onNotice: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");

  return (
    <div className="page page-enter">
      <header className="content-head content-head--compact"><h1>Settings.</h1></header>

      <section className="settings">
        <div className="settings__row">
          <span>Email</span>
          <p>{account.email}</p>
          {!account.emailVerified && (
            <button className="button button--outline" onClick={() => void auth.resendVerification().then(() => onNotice("Verification email sent.")).catch((reason) => onNotice(messageFor(reason)))}>
              Verify
            </button>
          )}
        </div>

        <div className="settings__row">
          <span>Sound</span>
          <p>{soundEnabled ? "On" : "Off"}</p>
          <button className="button button--outline" onClick={() => onSoundChange(!soundEnabled)}>{soundEnabled ? "Turn off" : "Turn on"}</button>
        </div>

        <div className="settings__row settings__row--danger">
          <span>Delete account</span>
          {confirming ? (
            <>
              <input type="password" autoComplete="current-password" value={password} placeholder="Confirm password" onChange={(event) => setPassword(event.target.value)} />
              <button
                className="button button--danger"
                disabled={!password}
                onClick={() => {
                  void profiles
                    .deleteAccount(password)
                    .then(() => window.location.reload())
                    .catch((reason) => onNotice(messageFor(reason)));
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <button className="button button--outline" onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      </section>
    </div>
  );
}
