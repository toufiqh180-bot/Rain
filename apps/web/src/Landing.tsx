import { useEffect, useRef, useState } from "react";

/**
 * The Rain landing page.
 *
 * Scroll is the only input. One requestAnimationFrame loop reads `scrollY`,
 * derives per-section progress and a smoothed scroll velocity, then writes both
 * to CSS custom properties on the page root. Everything visual is a paused CSS
 * keyframe animation scrubbed by a negative `animation-delay`, so the browser
 * interpolates on the compositor and React re-renders only when the chapter
 * word changes — four times over the whole page.
 *
 * The rain itself is a canvas. Drop speed, streak length and tilt follow scroll
 * velocity, so the storm accelerates and leans in the direction you scroll.
 */

type LandingProps = { onEnter: () => void; onSignIn: () => void };

const CHAPTERS = ["Text", "Voice", "Video", "Circles"] as const;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Progress of an element through the viewport, 0 when it pins, 1 when it releases. */
function pinProgress(element: HTMLElement | null) {
  if (!element) return 0;
  const bounds = element.getBoundingClientRect();
  const travel = Math.max(1, bounds.height - window.innerHeight);
  return Math.min(1, Math.max(0, -bounds.top / travel));
}

/** Progress of an element across the viewport, 0 as it enters, 1 as it leaves. */
function crossProgress(element: HTMLElement | null) {
  if (!element) return 0;
  const bounds = element.getBoundingClientRect();
  const travel = Math.max(1, window.innerHeight + bounds.height);
  return Math.min(1, Math.max(0, (window.innerHeight - bounds.top) / travel));
}

function RainMark({ className }: { className?: string }) {
  return (
    <svg className={className ?? "mark"} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M18 39.5h27.2a10.8 10.8 0 0 0 1-21.5A15.2 15.2 0 0 0 17.3 23 8.4 8.4 0 0 0 18 39.5Z" />
      <path d="m23 46-2 6m12-6-2 6m12-6-2 6" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Scroll-reactive rain                                                       */
/* ------------------------------------------------------------------------- */

type Drop = { x: number; y: number; depth: number; length: number };

function useRainCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>, velocityRef: React.MutableRefObject<number>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reduced = prefersReducedMotion();
    let drops: Drop[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;

    const seed = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Density scales with area so a wide desktop is not sparse and a phone is
      // not overloaded.
      const count = reduced ? 40 : Math.round(Math.min(340, (width * height) / 5200));
      drops = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        depth: 0.25 + Math.random() * 0.75,
        length: 8 + Math.random() * 18,
      }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      // Smoothed, signed scroll velocity in pixels per frame.
      const velocity = velocityRef.current;
      const boost = Math.min(1, Math.abs(velocity) / 55);
      const tilt = Math.max(-16, Math.min(16, velocity * 0.05));

      context.lineCap = "round";
      for (const drop of drops) {
        const fall = (0.7 + drop.depth * 2.6) * (1 + boost * 9);
        const streak = drop.length * drop.depth * (1 + boost * 8);
        const alpha = (0.06 + drop.depth * 0.2) * (1 + boost * 0.85);

        context.strokeStyle = `rgba(233, 233, 226, ${Math.min(0.55, alpha)})`;
        context.lineWidth = drop.depth * 1.15;
        context.beginPath();
        context.moveTo(drop.x, drop.y);
        context.lineTo(drop.x - tilt * drop.depth * 0.5, drop.y - streak);
        context.stroke();

        drop.y += fall;
        drop.x += tilt * drop.depth * 0.16;

        if (drop.y - streak > height) {
          drop.y = -streak;
          drop.x = Math.random() * width;
        }
        if (drop.x < -40) drop.x = width + 40;
        if (drop.x > width + 40) drop.x = -40;
      }
    };

    seed();

    if (reduced) {
      draw();
      window.addEventListener("resize", seed);
      return () => window.removeEventListener("resize", seed);
    }

    const loop = () => {
      draw();
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    window.addEventListener("resize", seed);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", seed);
    };
  }, [canvasRef, velocityRef]);
}

/* ------------------------------------------------------------------------- */

export default function Landing({ onEnter, onSignIn }: LandingProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const heroRef = useRef<HTMLElement | null>(null);
  const chaptersRef = useRef<HTMLElement | null>(null);
  const marqueeRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const velocityRef = useRef(0);

  const [chapter, setChapter] = useState(0);

  useRainCanvas(canvasRef, velocityRef);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let lastScroll = window.scrollY;
    let smoothedVelocity = 0;
    let frame = 0;
    let activeChapter = -1;

    const setVar = (name: string, value: number) => root.style.setProperty(name, value.toFixed(4));

    const measure = () => {
      const scroll = window.scrollY;
      const raw = scroll - lastScroll;
      lastScroll = scroll;
      // Critically damped-ish smoothing: quick to react, slow to settle, so the
      // storm keeps a little momentum after the finger lifts.
      smoothedVelocity += (raw - smoothedVelocity) * (Math.abs(raw) > Math.abs(smoothedVelocity) ? 0.45 : 0.09);
      velocityRef.current = smoothedVelocity;

      const documentTravel = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      setVar("--page", Math.min(1, scroll / documentTravel));
      setVar("--velocity", Math.min(1, Math.abs(smoothedVelocity) / 55));

      const hero = pinProgress(heroRef.current);
      setVar("--hero", hero);

      const chapters = pinProgress(chaptersRef.current);
      setVar("--chapters", chapters);
      const scaled = chapters * CHAPTERS.length;
      const index = Math.min(CHAPTERS.length - 1, Math.floor(scaled));
      setVar("--cp", Math.min(0.9999, scaled - index));
      if (index !== activeChapter) {
        activeChapter = index;
        setChapter(index);
      }

      setVar("--marquee", crossProgress(marqueeRef.current));
      setVar("--close", crossProgress(closeRef.current));
      root.dataset.lifted = scroll > 24 ? "true" : "false";

      frame = window.requestAnimationFrame(measure);
    };

    frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="lp" ref={rootRef} data-lifted="false">
      <canvas className="lp-rain" ref={canvasRef} aria-hidden="true" />

      <header className="lp-nav">
        <a className="lp-brand" href="#top" aria-label="Rain">
          <RainMark />
          <span>rain</span>
        </a>
        <div className="lp-nav__actions">
          <button type="button" className="lp-ghost" onClick={onSignIn}>
            Sign in
          </button>
          <button type="button" className="lp-solid" onClick={onEnter}>
            Enter Rain <Arrow />
          </button>
        </div>
      </header>

      {/* Hero — pinned while the wordmark settles and the storm builds. */}
      <section className="lp-hero" id="top" ref={heroRef}>
        <div className="lp-hero__pin">
          <div className="lp-hero__mark">
            <RainMark className="lp-hero__cloud" />
          </div>
          <h1 className="lp-hero__title">
            <span>Meet</span> <span>the</span> <em>unexpected.</em>
          </h1>
          <div className="lp-hero__cta">
            <button type="button" className="lp-solid lp-solid--lg" onClick={onEnter}>
              Enter Rain <Arrow />
            </button>
          </div>
          <div className="lp-hero__hint" aria-hidden="true">
            <i />
          </div>
        </div>
      </section>

      {/* Chapters — one pinned stage, four scrubbed scenes. */}
      <section className="lp-chapters" ref={chaptersRef} aria-label="Rain modes">
        <div className="lp-chapters__pin">
          <div className="lp-chapters__word">
            <span key={CHAPTERS[chapter]}>{CHAPTERS[chapter]}</span>
          </div>

          <div className="lp-stage" data-scene={CHAPTERS[chapter].toLowerCase()}>
            <div className="lp-stage__ring" aria-hidden="true" />

            <div className="scene scene--text" aria-hidden={chapter !== 0}>
              <p className="scene-bubble scene-bubble--them" />
              <p className="scene-bubble scene-bubble--me" />
              <p className="scene-bubble scene-bubble--them scene-bubble--last" />
            </div>

            <div className="scene scene--voice" aria-hidden={chapter !== 1}>
              <div className="scene-wave">
                {Array.from({ length: 28 }, (_, index) => (
                  <i key={index} style={{ "--i": index } as React.CSSProperties} />
                ))}
              </div>
            </div>

            <div className="scene scene--video" aria-hidden={chapter !== 2}>
              <div className="scene-frame">
                <span className="scene-frame__sweep" />
                <span className="scene-frame__iris" />
              </div>
            </div>

            <div className="scene scene--circles" aria-hidden={chapter !== 3}>
              <div className="scene-orbit">
                {Array.from({ length: 6 }, (_, index) => (
                  <i key={index} style={{ "--i": index } as React.CSSProperties} />
                ))}
              </div>
            </div>
          </div>

          <div className="lp-chapters__ticks" aria-hidden="true">
            {CHAPTERS.map((name, index) => (
              <i key={name} className={index <= chapter ? "is-on" : undefined} />
            ))}
          </div>
        </div>
      </section>

      {/* A long line of type dragged sideways by the scroll. */}
      <section className="lp-marquee" ref={marqueeRef} aria-hidden="true">
        <div className="lp-marquee__track">
          <span>text — voice — video — circles — </span>
          <span>text — voice — video — circles — </span>
        </div>
      </section>

      <section className="lp-close" ref={closeRef}>
        <h2>
          Somewhere out there,
          <br />
          <em>someone is free.</em>
        </h2>
        <button type="button" className="lp-solid lp-solid--lg" onClick={onEnter}>
          Enter Rain <Arrow />
        </button>
      </section>

      <footer className="lp-foot">
        <span>© 2026 Rain</span>
        <span>18+</span>
      </footer>
    </main>
  );
}
