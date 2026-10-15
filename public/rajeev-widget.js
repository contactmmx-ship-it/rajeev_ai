/*
 * Rajeev AI widget — add Rajeev AI voice to any Franchise Kart project.
 *
 *   <script src="https://<rajeev-ai-host>/rajeev-widget.js" data-project="ebill2tally" defer></script>
 *
 * Optional:
 *   data-position="left"       put the button bottom-left instead of bottom-right
 *   window.RajeevAI.setContext(fnOrString)
 *       What Rajeev should know about the current screen (plain text, max 4000 chars).
 *       Share only what the signed-in user can already see. Never pass passwords or keys.
 *
 * The project key and the website address must both be registered in
 * lib/embedProjects.ts on the Rajeev AI server, or the session is refused.
 */
(function () {
  "use strict";
  if (window.RajeevAI && window.RajeevAI.__loaded) return;

  var script = document.currentScript;
  var project = script && script.getAttribute("data-project");
  var position = (script && script.getAttribute("data-position")) === "left" ? "left" : "right";
  var apiBase = script ? new URL(script.src, location.href).origin : "";
  var contextSource = null;

  var api = {
    __loaded: true,
    setContext: function (v) { contextSource = v; },
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
  };
  window.RajeevAI = api;

  if (!project) {
    console.warn("[Rajeev AI] data-project is missing on the widget script tag.");
    return;
  }

  // ---------- UI (inside a shadow root so the host app's styles don't clash) ----------
  var host = document.createElement("div");
  host.setAttribute("data-rajeev-ai", project);
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.wrap{position:fixed;bottom:20px;' + position + ':20px;z-index:2147483000;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1f}' +
    '.fab{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:#1f3a8a;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}' +
    '.fab:focus-visible,.btn:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}' +
    '.fab svg{width:26px;height:26px}' +
    '.panel{position:absolute;bottom:68px;' + position + ':0;width:min(340px,calc(100vw - 32px));background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.22);overflow:hidden;display:none}' +
    '.panel.open{display:block}' +
    '.head{background:#1f3a8a;color:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}' +
    '.head b{font-size:15px}.x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}' +
    '.status{padding:10px 14px;color:#555;border-bottom:1px solid #eee}' +
    '.log{max-height:260px;overflow:auto;padding:10px 14px}.log:empty{display:none}' +
    '.m{margin:0 0 8px}.m.u{color:#555}.m.a{color:#1d1d1f}.m span{font-weight:600;margin-right:4px}' +
    '.foot{padding:10px 14px;display:flex;gap:8px}' +
    '.btn{flex:1;padding:10px;border-radius:10px;border:0;cursor:pointer;font-weight:600}' +
    '.go{background:#1f3a8a;color:#fff}.stop{background:#fee2e2;color:#991b1b}' +
    '.btn[disabled]{opacity:.5;cursor:default}' +
    '@media (prefers-color-scheme:dark){.panel{background:#1c1c1e;color:#f2f2f7}.status{color:#aaa;border-color:#333}.m.u{color:#aaa}.m.a{color:#f2f2f7}}' +
    '</style>' +
    '<div class="wrap">' +
    '<div class="panel" role="dialog" aria-label="Rajeev AI">' +
    '<div class="head"><b>Rajeev AI</b><button class="x" aria-label="Close">×</button></div>' +
    '<div class="status" aria-live="polite">Tap Start and speak. Hindi, English or Hinglish.</div>' +
    '<div class="log"></div>' +
    '<div class="foot"><button class="btn go">Start talking</button><button class="btn stop" disabled>Stop</button></div>' +
    '</div>' +
    '<button class="fab" aria-label="Talk to Rajeev AI" title="Talk to Rajeev AI">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>' +
    '</button>' +
    '</div>';

  function $(sel) { return root.querySelector(sel); }
  var panel = $(".panel"), statusEl = $(".status"), logEl = $(".log"), goBtn = $(".go"), stopBtn = $(".stop");

  function setOpen(v) { panel.classList.toggle("open", !!v); }
  function setStatus(t) { statusEl.textContent = t; }
  $(".fab").addEventListener("click", function () { setOpen(!panel.classList.contains("open")); });
  $(".x").addEventListener("click", function () { setOpen(false); });
  goBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);

  function mount() { document.body.appendChild(host); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  // ---------- transcript ----------
  var items = {};
  function upsert(id, role, text, mode) {
    var el = items[id];
    if (!el) {
      el = document.createElement("p");
      el.className = "m " + (role === "user" ? "u" : "a");
      var who = document.createElement("span");
      who.textContent = role === "user" ? "You:" : "Rajeev:";
      el.appendChild(who);
      el.appendChild(document.createTextNode(""));
      items[id] = el;
      logEl.appendChild(el);
    }
    var t = el.lastChild;
    t.nodeValue = mode === "append" ? t.nodeValue + text : text;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- voice session ----------
  var pc = null, dc = null, mic = null, audio = null;

  function readContext() {
    try {
      var v = typeof contextSource === "function" ? contextSource() : contextSource;
      return typeof v === "string" ? v.slice(0, 4000) : "";
    } catch (e) {
      return "";
    }
  }

  function cleanup() {
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    if (mic) mic.getTracks().forEach(function (t) { t.stop(); });
    pc = dc = mic = null;
    goBtn.disabled = false;
    stopBtn.disabled = true;
  }

  function stop() {
    cleanup();
    setStatus("Call ended.");
  }

  async function start() {
    goBtn.disabled = true;
    setStatus("Connecting…");
    var res, data;
    try {
      res = await fetch(apiBase + "/api/embed/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: project, pageContext: readContext() }),
      });
      data = await res.json();
    } catch (e) {
      setStatus("Could not reach Rajeev AI. Check your internet.");
      goBtn.disabled = false;
      return;
    }
    if (!res.ok || !data || !data.value) {
      setStatus((data && data.error) || "Rajeev AI is not available right now.");
      goBtn.disabled = false;
      return;
    }

    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus("Microphone is blocked. Allow it in your browser settings.");
      goBtn.disabled = false;
      return;
    }

    pc = new RTCPeerConnection();
    audio = audio || new Audio();
    audio.autoplay = true;
    pc.ontrack = function (e) { audio.srcObject = e.streams[0]; };
    mic.getTracks().forEach(function (t) { pc.addTrack(t, mic); });

    dc = pc.createDataChannel("oai-events");
    dc.onopen = function () {
      dc.send(JSON.stringify({
        type: "response.create",
        response: { instructions: "Greet the user briefly as Rajeev AI and ask how you can help on this screen." },
      }));
      stopBtn.disabled = false;
      setStatus("Listening…");
    };
    dc.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      switch (msg.type) {
        case "input_audio_buffer.speech_started": setStatus("Listening…"); break;
        case "conversation.item.input_audio_transcription.delta": upsert(msg.item_id, "user", msg.delta || "", "append"); break;
        case "conversation.item.input_audio_transcription.completed": upsert(msg.item_id, "user", msg.transcript || "", "replace"); break;
        case "response.output_audio_transcript.delta": setStatus("Rajeev is speaking…"); upsert(msg.item_id, "assistant", msg.delta || "", "append"); break;
        case "response.output_audio_transcript.done": upsert(msg.item_id, "assistant", msg.transcript || "", "replace"); break;
        case "response.done": setStatus("Listening…"); break;
        case "error": setStatus("Voice error. Tap Stop and try again."); break;
      }
    };

    try {
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      var sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: "Bearer " + data.value, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      var answer = await sdpRes.text();
      if (!sdpRes.ok) throw new Error(answer.slice(0, 200));
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (e) {
      cleanup();
      setStatus("Could not connect to the voice model.");
    }
  }
})();
