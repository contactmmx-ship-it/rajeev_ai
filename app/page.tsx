"use client";
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

type Phase = "idle" | "connecting" | "live" | "saving";
type AuthMode = "loading" | "disabled" | "signedOut" | "signedIn";
type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
  ts: number;
};
type MemorySnapshot = { configured: boolean; isReturning: boolean; factCount: number; openActionItems: number };
type CompanyBrand = { id: string; name: string; brandName: string; primaryColor: string; logoUrl: string | null };
type Assessment = {
  overall_score: number;
  tier: string;
  created_at: string;
} | null;
type ActionItem = { id: string; description: string; status: string };
type AgentAction = { id: string; agent_name: string; description: string; status: string; last_error?: string | null };

const ANON_ID_KEY = "rajeev_anon_id";

function getAnonId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(ANON_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(ANON_ID_KEY, id);
  }
  return id;
}

function readLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / data.length);
  return Math.min(1, rms * 4);
}

export default function Home() {
  // Voice call state (V1)
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Tap to talk");
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [memory, setMemory] = useState<MemorySnapshot>({
    configured: false,
    isReturning: false,
    factCount: 0,
    openActionItems: 0,
  });
  const [level, setLevel] = useState(0);

  // V7 — multi-company / white-label
  const [company, setCompany] = useState<CompanyBrand | null>(null);
  const [companyNameInput, setCompanyNameInput] = useState("");
  const [joinCompanyIdInput, setJoinCompanyIdInput] = useState("");

  // V2 — auth
  const [authMode, setAuthMode] = useState<AuthMode>("loading");
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // V3/V4/V5/V6 — business panel
  const [panelOpen, setPanelOpen] = useState(false);
  const [assessment, setAssessment] = useState<Assessment>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [pendingActions, setPendingActions] = useState<AgentAction[]>([]);

  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const authUserId = useRef<string>("");
  const personId = useRef<string>("");
  const conversationId = useRef<string | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const itemIndex = useRef<Map<string, number>>(new Map());
  const audioCtx = useRef<AudioContext | null>(null);
  const rafId = useRef<number | null>(null);
  const localAnalyser = useRef<AnalyserNode | null>(null);
  const remoteAnalyser = useRef<AnalyserNode | null>(null);
  const assistantSpeakingRef = useRef(false);

  useEffect(() => {
    assistantSpeakingRef.current = assistantSpeaking;
  }, [assistantSpeaking]);

  // ---- V2: resolve auth (or fall back to anonymous if not configured) ----
  useEffect(() => {
    const supabase = getSupabaseBrowser();

    if (!supabase) {
      authUserId.current = getAnonId();
      setAuthMode("disabled");
      loadPersonAndPanels(authUserId.current);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        authUserId.current = data.session.user.id;
        setAuthMode("signedIn");
        loadPersonAndPanels(authUserId.current);
      } else {
        setAuthMode("signedOut");
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        authUserId.current = session.user.id;
        setAuthMode("signedIn");
        loadPersonAndPanels(authUserId.current);
      } else {
        setAuthMode("signedOut");
      }
    });

    return () => {
      sub.subscription.unsubscribe();
      cleanupConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPersonAndPanels(uid: string) {
    try {
      const res = await fetch(`/api/person?authUserId=${uid}`);
      const data = await res.json();
      if (data.personId) {
        personId.current = data.personId;
        setMemory({
          configured: !!data.isConfigured,
          isReturning: !!data.isReturning,
          factCount: data.factCount || 0,
          openActionItems: data.openActionItemCount || 0,
        });
        setCompany(data.company || null);
        refreshPanels();
      }
    } catch {
      // Non-fatal — panels just stay empty until the first call resolves it.
    }
  }

  async function refreshPanels() {
    if (!personId.current) return;
    try {
      const [assessRes, projRes, agentRes] = await Promise.all([
        fetch(`/api/methodology/assess?personId=${personId.current}`).then((r) => r.json()),
        fetch(`/api/projects?personId=${personId.current}`).then((r) => r.json()),
        // No status filter: the panel needs to show proposed (decide),
        // approved (execute), and execution_failed (retry) all at once.
        fetch(`/api/agents/actions?personId=${personId.current}`).then((r) => r.json()),
      ]);
      setAssessment(assessRes.latest || null);
      setActionItems((projRes.actionItems || []).filter((i: ActionItem) => i.status === "open"));
      setPendingActions((agentRes.actions || []).filter((a: AgentAction) => a.status !== "rejected" && a.status !== "executed"));
    } catch {
      // Panels are a convenience view — never block the core flow on this.
    }
  }

  async function createCompany() {
    if (!personId.current || !companyNameInput.trim()) return;
    try {
      const res = await fetch("/api/person", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: personId.current, createCompanyName: companyNameInput.trim() }),
      });
      const data = await res.json();
      if (data.company) {
        setCompany(data.company);
        setCompanyNameInput("");
      }
    } catch {
      // Non-fatal — the person can retry from the panel.
    }
  }

  async function joinCompany() {
    if (!personId.current || !joinCompanyIdInput.trim()) return;
    try {
      const res = await fetch("/api/person", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: personId.current, companyId: joinCompanyIdInput.trim() }),
      });
      const data = await res.json();
      if (data.company) {
        setCompany(data.company);
        setJoinCompanyIdInput("");
      }
    } catch {
      // Non-fatal — the person can retry from the panel.
    }
  }

  async function sendMagicLink() {
    const supabase = getSupabaseBrowser();
    if (!supabase || !email) return;
    setAuthError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined },
    });
    if (error) setAuthError(error.message);
    else setMagicLinkSent(true);
  }

  async function signOut() {
    const supabase = getSupabaseBrowser();
    await supabase?.auth.signOut();
    setMagicLinkSent(false);
    setEmail("");
  }

  async function decideAgentAction(id: string, decision: "approved" | "rejected") {
    await fetch(`/api/agents/actions/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, decidedBy: authUserId.current }),
    });
    refreshPanels();
  }

  async function executeAgentAction(id: string) {
    await fetch(`/api/agents/actions/${id}/execute`, { method: "POST" });
    refreshPanels();
  }

  async function markActionDone(id: string) {
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionItemId: id, status: "done" }),
    });
    refreshPanels();
  }

  function cleanupConnection() {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = null;
    pc.current?.getSenders().forEach((s) => s.track?.stop());
    pc.current?.close();
    pc.current = null;
    dc.current = null;
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    localAnalyser.current = null;
    remoteAnalyser.current = null;
  }

  function upsertTranscript(
    itemId: string,
    role: "user" | "assistant",
    text: string,
    mode: "append" | "replace",
    final: boolean
  ) {
    setTranscript((prev) => {
      const next = [...prev];
      const key = `${role}:${itemId}`;
      const idx = itemIndex.current.get(key);
      if (idx !== undefined && next[idx]) {
        next[idx] = {
          ...next[idx],
          text: mode === "append" ? next[idx].text + text : text,
          final,
        };
      } else {
        const entry: TranscriptEntry = { id: itemId, role, text, final, ts: Date.now() };
        next.push(entry);
        itemIndex.current.set(key, next.length - 1);
      }
      const trimmed = next.slice(-12);
      transcriptRef.current = trimmed;
      return trimmed;
    });
  }

  function markInterrupted() {
    setTranscript((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant" && !next[i].final) {
          next[i] = { ...next[i], final: true, interrupted: true };
          break;
        }
      }
      transcriptRef.current = next;
      return next;
    });
  }

  function startLevelLoop() {
    const loop = () => {
      let v = 0;
      if (assistantSpeakingRef.current && remoteAnalyser.current) {
        v = readLevel(remoteAnalyser.current);
      } else if (localAnalyser.current) {
        v = readLevel(localAnalyser.current);
      }
      setLevel(v);
      rafId.current = requestAnimationFrame(loop);
    };
    rafId.current = requestAnimationFrame(loop);
  }

  async function start() {
    setPhase("connecting");
    setStatus("Connecting…");
    setTranscript([]);
    transcriptRef.current = [];
    itemIndex.current.clear();

    let tokenRes: Response;
    let tokenData: any;
    try {
      tokenRes = await fetch("/api/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authUserId: authUserId.current }),
      });
      tokenData = await tokenRes.json();
    } catch {
      setStatus("Could not reach the server. Check your connection.");
      setPhase("idle");
      return;
    }

    if (!tokenRes.ok) {
      setStatus(tokenData?.error || "Could not start the session.");
      setPhase("idle");
      return;
    }

    if (tokenData.personId) personId.current = tokenData.personId;
    conversationId.current = tokenData.conversationId || null;
    setMemory((m) => ({
      ...m,
      isReturning: !!tokenData.isReturning,
      factCount: tokenData.factCount ?? m.factCount,
      openActionItems: tokenData.openActionItemCount ?? m.openActionItems,
    }));
    if (tokenData.company) setCompany(tokenData.company);

    const peer = new RTCPeerConnection();
    pc.current = peer;

    peer.ontrack = (e) => {
      if (audioEl.current) audioEl.current.srcObject = e.streams[0];
      try {
        const ctx = audioCtx.current || new AudioContext();
        audioCtx.current = ctx;
        const source = ctx.createMediaStreamSource(e.streams[0]);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        remoteAnalyser.current = analyser;
      } catch {
        // Level metering is cosmetic — never let it block playback.
      }
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("Microphone access is blocked. Allow it in your browser settings.");
      setPhase("idle");
      peer.close();
      pc.current = null;
      return;
    }

    stream.getTracks().forEach((t) => peer.addTrack(t, stream));

    try {
      const ctx = audioCtx.current || new AudioContext();
      audioCtx.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      localAnalyser.current = analyser;
    } catch {
      // Cosmetic only.
    }

    const channel = peer.createDataChannel("oai-events");
    dc.current = channel;

    channel.onopen = () => {
      channel.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: tokenData.isReturning
              ? "Greet the user briefly and warmly, like you're picking up an ongoing relationship. Don't recite facts at them — just sound like you remember them."
              : "Greet the user briefly as Rajeev AI and invite them to speak naturally.",
          },
        })
      );
      setPhase("live");
      setStatus("Listening…");
      startLevelLoop();
    };

    channel.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "input_audio_buffer.speech_started":
          setAssistantSpeaking(false);
          setStatus("Listening…");
          markInterrupted();
          break;

        case "conversation.item.input_audio_transcription.delta":
          upsertTranscript(msg.item_id, "user", msg.delta || "", "append", false);
          break;

        case "conversation.item.input_audio_transcription.completed":
          upsertTranscript(msg.item_id, "user", msg.transcript || "", "replace", true);
          break;

        case "response.output_audio_transcript.delta":
          setAssistantSpeaking(true);
          setStatus("Rajeev is speaking…");
          upsertTranscript(msg.item_id, "assistant", msg.delta || "", "append", false);
          break;

        case "response.output_audio_transcript.done":
          upsertTranscript(msg.item_id, "assistant", msg.transcript || "", "replace", true);
          break;

        case "response.done":
          setAssistantSpeaking(false);
          setStatus((s) => (s === "Rajeev is speaking…" ? "Listening…" : s));
          break;

        default:
          break;
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    try {
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      const answer = await sdp.text();
      if (!sdp.ok) throw new Error(answer.slice(0, 300));
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
    } catch {
      setStatus("Could not connect to the voice model.");
      setPhase("idle");
      cleanupConnection();
    }
  }

  async function stop() {
    setPhase("saving");
    setStatus("Saving to memory…");

    const finalTranscript = transcriptRef.current
      .filter((t) => t.text.trim().length > 0)
      .map((t) => ({ role: t.role, text: t.text, ts: t.ts }));

    cleanupConnection();

    if (personId.current && conversationId.current) {
      try {
        const res = await fetch("/api/memory/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            personId: personId.current,
            conversationId: conversationId.current,
            transcript: finalTranscript,
          }),
        });
        const data = await res.json();
        if (data.saved) {
          setMemory((m) => ({
            ...m,
            factCount: m.factCount + (data.factsExtracted || 0),
            isReturning: true,
          }));
          refreshPanels();
        }
      } catch {
        // Non-fatal — the conversation itself is over either way.
      }
    }

    setPhase("idle");
    setStatus("Tap to talk");
    setAssistantSpeaking(false);
  }

  const isLive = phase === "live";
  const isConnecting = phase === "connecting";
  const isSaving = phase === "saving";
  const visibleTranscript = transcript.slice(-4);
  const orbStyle: React.CSSProperties & Record<string, number> = { "--level": level };
  const brandName = company?.brandName || "Rajeev AI";
  const wrapStyle: React.CSSProperties & Record<string, string> = {
    "--brand": company?.primaryColor || "#c9a84c",
  };

  // ---- V2: auth gate ----
  if (authMode === "loading") {
    return (
      <main className="wrap" style={wrapStyle}>
        <p className="status">Loading…</p>
        <style jsx>{globalStyles}</style>
      </main>
    );
  }

  if (authMode === "signedOut") {
    return (
      <main className="wrap" style={wrapStyle}>
        <section className="stage">
          <div className="eyebrow">◉ {brandName}</div>
          <h1>Your thinking partner.</h1>
          {magicLinkSent ? (
            <p className="status">Check your email for a sign-in link.</p>
          ) : (
            <div className="authBox">
              <input
                className="authInput"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="authButton" onClick={sendMagicLink} disabled={!email}>
                Send sign-in link
              </button>
              {authError && <p className="authError">{authError}</p>}
            </div>
          )}
        </section>
        <style jsx>{globalStyles}</style>
      </main>
    );
  }

  return (
    <main className="wrap" style={wrapStyle}>
      <audio ref={audioEl} autoPlay />
      <section className="stage">
        <div className="eyebrow">◉ {brandName}</div>
        <h1>Your thinking partner.</h1>

        <button
          className={`orb ${isLive ? (assistantSpeaking ? "speaking" : "listening") : ""} ${
            isConnecting ? "connecting" : ""
          }`}
          style={orbStyle}
          onClick={isLive || isConnecting || isSaving ? stop : start}
          disabled={isConnecting || isSaving}
          aria-label={isLive ? "End conversation" : "Talk to Rajeev"}
        >
          <span className="orbRing" />
          <span className="orbCore" />
          <span className="orbLabel">{isLive ? "End" : isConnecting ? "…" : "🎙️ Talk to Rajeev"}</span>
        </button>

        <p className="status">{status}</p>

        {visibleTranscript.length > 0 && (
          <div className="captions" aria-live="polite">
            {visibleTranscript.map((t, i) => (
              <div
                key={t.id + t.role + i}
                className={`line ${t.role} ${t.interrupted ? "interrupted" : ""}`}
                style={{ opacity: 0.35 + (0.65 * (i + 1)) / visibleTranscript.length }}
              >
                <span className="who">{t.role === "user" ? "You" : "Rajeev"}</span>
                <span className="text">
                  {t.text}
                  {t.interrupted ? " —" : ""}
                </span>
              </div>
            ))}
          </div>
        )}

        {memory.configured && (
          <p className="memoryBadge">
            {memory.isReturning
              ? `Remembers ${memory.factCount} thing${memory.factCount === 1 ? "" : "s"} about you`
              : "First conversation"}
            {memory.openActionItems > 0 ? ` · ${memory.openActionItems} open item${memory.openActionItems === 1 ? "" : "s"}` : ""}
          </p>
        )}

        {memory.configured && (
          <button className="panelToggle" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "Hide" : "Show"} business & agents
          </button>
        )}

        {panelOpen && (
          <div className="panel">
            <div className="panelSection">
              <h2>Business Advisor</h2>
              {assessment ? (
                <p>
                  Latest read: <strong>{assessment.tier}</strong> ({assessment.overall_score}/100)
                </p>
              ) : (
                <p className="dim">No assessment yet — comes up naturally once a call covers your business in depth.</p>
              )}
            </div>

            <div className="panelSection">
              <h2>Open items</h2>
              {actionItems.length === 0 && <p className="dim">Nothing open right now.</p>}
              {actionItems.map((item) => (
                <div key={item.id} className="panelRow">
                  <span>{item.description}</span>
                  <button className="smallButton" onClick={() => markActionDone(item.id)}>
                    Done
                  </button>
                </div>
              ))}
            </div>

            <div className="panelSection">
              <h2>Agents</h2>
              {pendingActions.length === 0 && <p className="dim">Nothing pending.</p>}
              {pendingActions.map((a) => (
                <div key={a.id} className="panelRow">
                  <span>
                    <strong>{a.agent_name}</strong> — {a.description}
                    {a.status === "approved" && <span className="tag">approved</span>}
                    {a.status === "execution_failed" && (
                      <span className="tagError" title={a.last_error || undefined}>
                        failed to execute
                      </span>
                    )}
                  </span>
                  <span className="panelActions">
                    {a.status === "proposed" && (
                      <>
                        <button className="smallButton" onClick={() => decideAgentAction(a.id, "approved")}>
                          Approve
                        </button>
                        <button className="smallButton ghost" onClick={() => decideAgentAction(a.id, "rejected")}>
                          Reject
                        </button>
                      </>
                    )}
                    {a.status === "approved" && (
                      <button className="smallButton" onClick={() => executeAgentAction(a.id)}>
                        Execute
                      </button>
                    )}
                    {a.status === "execution_failed" && (
                      <button className="smallButton" onClick={() => executeAgentAction(a.id)}>
                        Retry
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>

            <div className="panelSection">
              <h2>Company</h2>
              {company ? (
                <p>
                  <strong>{company.name}</strong> — appears as "{company.brandName}". Share id{" "}
                  <code className="companyId">{company.id}</code> for teammates to join.
                </p>
              ) : (
                <div className="companyForms">
                  <div className="companyFormRow">
                    <input
                      className="authInput small"
                      placeholder="Create a company (name)"
                      value={companyNameInput}
                      onChange={(e) => setCompanyNameInput(e.target.value)}
                    />
                    <button className="smallButton" onClick={createCompany} disabled={!companyNameInput.trim()}>
                      Create
                    </button>
                  </div>
                  <div className="companyFormRow">
                    <input
                      className="authInput small"
                      placeholder="Join with a company id"
                      value={joinCompanyIdInput}
                      onChange={(e) => setJoinCompanyIdInput(e.target.value)}
                    />
                    <button className="smallButton" onClick={joinCompany} disabled={!joinCompanyIdInput.trim()}>
                      Join
                    </button>
                  </div>
                </div>
              )}
            </div>

            {authMode === "signedIn" && (
              <button className="smallButton ghost" onClick={signOut}>
                Sign out
              </button>
            )}
          </div>
        )}
      </section>

      <style jsx>{globalStyles}</style>
    </main>
  );
}

const globalStyles = `
  .wrap {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .stage {
    text-align: center;
    max-width: 560px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .eyebrow {
    font-family: "Fraunces", serif;
    font-size: 15px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--brand, #c9a84c);
    opacity: 0.85;
  }
  h1 {
    font-family: "Fraunces", serif;
    font-weight: 500;
    font-size: clamp(30px, 6vw, 44px);
    margin: 0 0 8px;
    color: #f3efe4;
    letter-spacing: -0.01em;
  }
  .status {
    color: #8f8a7c;
    font-size: 15px;
    min-height: 20px;
    margin: 4px 0 0;
  }
  .memoryBadge {
    font-size: 13px;
    color: #6f6a5e;
    letter-spacing: 0.02em;
    margin: 0;
  }
  .orb {
    position: relative;
    width: 176px;
    height: 176px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 25%, transparent);
    background: radial-gradient(circle at 35% 30%, #201d17, #0d0c0a 70%);
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: transform 0.2s ease;
    padding: 0;
  }
  .orb:hover:not(:disabled) {
    transform: scale(1.02);
  }
  .orb:disabled {
    cursor: progress;
    opacity: 0.85;
  }
  .orbCore {
    position: absolute;
    inset: 30%;
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--brand, #c9a84c) 85%, white), color-mix(in srgb, var(--brand, #c9a84c) 70%, black) 70%);
    animation: breathe 4s ease-in-out infinite;
    transform: scale(calc(1 + var(--level, 0) * 0.25));
  }
  .orb.speaking .orbCore {
    animation: none;
    background: radial-gradient(circle, color-mix(in srgb, var(--brand, #c9a84c) 95%, white), color-mix(in srgb, var(--brand, #c9a84c) 60%, black) 70%);
    box-shadow: 0 0 40px color-mix(in srgb, var(--brand, #c9a84c) 40%, transparent);
  }
  .orb.connecting .orbCore {
    animation: breathe 1s ease-in-out infinite;
  }
  .orbRing {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 35%, transparent);
    opacity: 0;
  }
  .orb.listening .orbRing {
    animation: ringPulse 1.6s ease-out infinite;
    opacity: 1;
  }
  .orbLabel {
    position: relative;
    z-index: 2;
    font-size: 14px;
    color: #f3efe4;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .captions {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 96px;
    width: 100%;
  }
  .line {
    animation: fadeIn 0.25s ease;
    font-size: 15px;
    line-height: 1.4;
    text-align: left;
    display: flex;
    gap: 8px;
  }
  .line .who {
    flex: 0 0 auto;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: color-mix(in srgb, var(--brand, #c9a84c) 70%, black);
    padding-top: 3px;
    min-width: 46px;
  }
  .line.assistant .who {
    color: var(--brand, #c9a84c);
  }
  .line .text {
    color: #d9d4c7;
  }
  .line.interrupted .text {
    color: #6f6a5e;
    font-style: italic;
  }
  .authBox {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    max-width: 320px;
    margin-top: 12px;
  }
  .authInput {
    background: #16140f;
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 30%, transparent);
    border-radius: 8px;
    padding: 10px 12px;
    color: #f3efe4;
    font-size: 15px;
  }
  .authButton {
    background: var(--brand, #c9a84c);
    color: #0a0a0c;
    border: none;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .authButton:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .authError {
    color: #d97757;
    font-size: 13px;
    margin: 0;
  }
  .panelToggle {
    background: none;
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 30%, transparent);
    color: var(--brand, #c9a84c);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
    margin-top: 4px;
  }
  .panel {
    width: 100%;
    text-align: left;
    background: #14120d;
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 18%, transparent);
    border-radius: 12px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 4px;
  }
  .panelSection h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: color-mix(in srgb, var(--brand, #c9a84c) 70%, black);
    margin: 0 0 8px;
  }
  .panelSection p {
    font-size: 14px;
    color: #d9d4c7;
    margin: 0;
  }
  .panelSection p.dim {
    color: #6f6a5e;
  }
  .panelRow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: #d9d4c7;
    padding: 6px 0;
    border-top: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 8%, transparent);
  }
  .panelActions {
    display: flex;
    gap: 6px;
  }
  .smallButton {
    background: color-mix(in srgb, var(--brand, #c9a84c) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--brand, #c9a84c) 30%, transparent);
    color: var(--brand, #c9a84c);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .smallButton.ghost {
    background: none;
    color: #8f8a7c;
  }
  .smallButton:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .companyForms {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .companyFormRow {
    display: flex;
    gap: 8px;
  }
  .authInput.small {
    flex: 1;
    padding: 6px 10px;
    font-size: 13px;
  }
  .companyId {
    background: color-mix(in srgb, var(--brand, #c9a84c) 12%, transparent);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .tag {
    margin-left: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--brand, #c9a84c);
    opacity: 0.8;
  }
  .tagError {
    margin-left: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #d97757;
    cursor: help;
  }
`;
