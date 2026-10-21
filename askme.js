/*
 * Ask About Me widget. Drop-in: <div data-askme data-api="https://..." data-sitekey="..."
 * data-contact="https://..."></div> plus askme.css and this script.
 *
 * On page load it runs Cloudflare Turnstile and posts the token to /warm, which wakes
 * the model. Answers are entries Jeremiah wrote, rendered with textContent only, so
 * nothing here can turn into markup. Every other string on screen is fixed copy below.
 */
(() => {
  "use strict";

  // Cloudflare's always-pass test key, used automatically on localhost.
  const TEST_SITEKEY = "1x00000000000000000000AA";
  const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  const REQUEST_TIMEOUT_MS = 150000;
  const MAX_CHARS = 300;

  const COPY = {
    label: "Ask about Jeremiah's experience",
    placeholder: "e.g. Has he built agentic tools?",
    submit: "Ask",
    warming: "Warming up… you got here too fast 😄",
    thinking: "Checking the record…",
    intro: "From Jeremiah's record:",
    noMatch: "That's not in my record.",
    outOfScope: "I can only answer questions about Jeremiah's professional experience.",
    invalid: "Try a shorter question.",
    reach: "Here's how to reach Jeremiah",
    rateLimited: "That's a lot of questions. Try again in a minute.",
    unavailable: "The answer service isn't available right now.",
    verifyFailed: "Couldn't verify this browser. Try reloading the page.",
    note: "Answers are statements Jeremiah wrote, shown word for word.",
    gateLabel: "This is a preview for friends. Enter the access code.",
    gateWrong: "That code didn't work. Try again.",
    gateSubmit: "Unlock",
  };

  const CODE_KEY = "askme-access-code";
  const store = {
    get() { try { return localStorage.getItem(CODE_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(CODE_KEY, v); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(CODE_KEY); } catch { /* private mode */ } },
  };

  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!turnstileLoading) {
      turnstileLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TURNSTILE_SRC;
        s.async = true;
        s.onload = () => resolve(window.turnstile);
        s.onerror = () => reject(new Error("turnstile failed to load"));
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function safeUrl(url) {
    return typeof url === "string" && /^(https?:|mailto:)/i.test(url) ? url : null;
  }

  async function post(url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await r.json(); } catch { /* non-JSON error body */ }
      return { status: r.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  class AskMe {
    constructor(root) {
      this.root = root;
      this.api = (root.dataset.api || (isLocal ? location.origin : "")).replace(/\/$/, "");
      this.sitekey = isLocal ? TEST_SITEKEY : root.dataset.sitekey;
      const contact = root.dataset.contact || "";
      this.contact = safeUrl(contact) || (/^#[\w-]+$/.test(contact) ? contact : null);  // or an in-page anchor
      this.warmed = false;
      this.busy = false;
      this.build();
      this.startWarm();
    }

    build() {
      const form = el("form", "askme-form");
      const id = `askme-q-${Math.random().toString(36).slice(2, 8)}`;
      const label = el("label", "askme-label", COPY.label);
      label.htmlFor = id;
      const row = el("div", "askme-row");
      this.input = el("input", "askme-input");
      Object.assign(this.input, { id, type: "text", placeholder: COPY.placeholder, maxLength: MAX_CHARS, autocomplete: "off" });
      this.button = el("button", "askme-button", COPY.submit);
      this.button.type = "submit";
      row.append(this.input, this.button);
      form.append(label, row);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = this.input.value.trim();
        if (q && !this.busy) this.ask(q);
      });

      this.form = form;

      this.gate = el("form", "askme-form askme-gate");
      this.gate.hidden = true;
      const gateId = `${id}-code`;
      this.gateLabel = el("label", "askme-label", COPY.gateLabel);
      this.gateLabel.htmlFor = gateId;
      const gateRow = el("div", "askme-row");
      this.codeInput = el("input", "askme-input");
      Object.assign(this.codeInput, { id: gateId, type: "password", autocomplete: "current-password", maxLength: 200 });
      const unlock = el("button", "askme-button", COPY.gateSubmit);
      unlock.type = "submit";
      gateRow.append(this.codeInput, unlock);
      this.gate.append(this.gateLabel, gateRow);
      this.gate.addEventListener("submit", (e) => {
        e.preventDefault();
        const code = this.codeInput.value.trim();
        if (!code) return;
        store.set(code);
        this.gate.hidden = true;
        this.form.hidden = false;
        this.output.replaceChildren();
        this.startWarm();
      });

      this.output = el("div", "askme-output");
      this.output.setAttribute("aria-live", "polite");
      this.challenge = el("div", "askme-challenge");
      this.root.replaceChildren(this.gate, form, this.output, this.challenge, el("p", "askme-note", COPY.note));
      this.root.classList.add("askme");
    }

    showGate(wrong) {
      this.form.hidden = true;
      this.gate.hidden = false;
      this.gateLabel.textContent = wrong ? COPY.gateWrong : COPY.gateLabel;
      this.codeInput.value = "";
      this.output.replaceChildren();
      this.codeInput.focus({ preventScroll: true });
    }

    // The warm promise resolves to a session token once Turnstile passes and /warm answers.
    startWarm() {
      this.warmed = false;
      this.warm = new Promise((resolve, reject) => {
        this.resolveToken = resolve;
        this.rejectToken = reject;
      }).then((token) => this.postWarm(token));
      // A missing or wrong access code shows the gate right away; other errors wait
      // until the visitor asks.
      this.warm.catch((err) => {
        if (err && (err.message === "code_required" || err.message === "code_invalid")) {
          this.showGate(err.message === "code_invalid");
        }
      });

      if (!this.api || !this.sitekey) {
        this.rejectToken(new Error("widget is missing data-api or data-sitekey"));
        return;
      }
      loadTurnstile().then((ts) => {
        const opts = {
          sitekey: this.sitekey,
          action: "warm",
          appearance: "interaction-only",
          callback: (token) => this.resolveToken(token),
          "error-callback": () => this.rejectToken(new Error("verify")),
        };
        if (this.widgetId == null) this.widgetId = ts.render(this.challenge, opts);
        else ts.reset(this.widgetId);
      }, (err) => this.rejectToken(err));
    }

    async postWarm(token) {
      const code = store.get();
      const r = await post(`${this.api}/warm`, code ? { token, code } : { token });
      if (r.status === 401) {
        if (code) store.clear();
        throw new Error(code ? "code_invalid" : "code_required");
      }
      if (r.status === 403) throw new Error("verify");
      if (r.status === 429) throw new Error("rate");
      if (r.status !== 200 || !r.data || !r.data.session) throw new Error("unavailable");
      this.warmed = true;
      return r.data.session;
    }

    async ask(question) {
      this.busy = true;
      this.button.disabled = true;
      try {
        this.status(this.warmed ? COPY.thinking : COPY.warming);
        let session = await this.warm;
        this.status(COPY.thinking);
        let r = await post(`${this.api}/ask`, { question, session });
        if (r.status === 403) {  // session expired: verify again, once
          this.startWarm();
          session = await this.warm;
          r = await post(`${this.api}/ask`, { question, session });
        }
        if (r.status === 429) return this.message(COPY.rateLimited);
        if (r.status !== 200 || !r.data) return this.message(COPY.unavailable, true);
        this.render(r.data);
      } catch (err) {
        const msg = err && err.message;
        if (msg === "code_required" || msg === "code_invalid") return;  // the gate is already showing
        if (msg === "verify") this.message(COPY.verifyFailed, true);
        else if (msg === "rate") this.message(COPY.rateLimited);
        else this.message(COPY.unavailable, true);
        if (msg !== "rate") this.startWarm();  // let a later question try again
      } finally {
        this.busy = false;
        this.button.disabled = false;
      }
    }

    status(text) {
      this.output.replaceChildren(el("p", "askme-status", text));
    }

    message(text, withContact = false) {
      const p = el("p", "askme-message", text);
      if (withContact) this.appendContact(p);
      this.output.replaceChildren(p);
    }

    appendContact(parent) {
      if (!this.contact) return;
      const a = el("a", "askme-contact", COPY.reach);
      a.href = this.contact;
      a.rel = "noopener noreferrer";
      parent.append(" ", a, ".");
    }

    render(data) {
      if (!data.answerable || !Array.isArray(data.entries) || !data.entries.length) {
        if (data.reason === "invalid") return this.message(COPY.invalid);
        if (data.reason === "out_of_scope") return this.message(COPY.outOfScope, true);
        return this.message(COPY.noMatch, true);
      }
      const list = el("ul", "askme-cards");
      for (const entry of data.entries) {
        const card = el("li", "askme-card");
        const head = el("div", "askme-card-head");
        head.append(el("span", "askme-card-title", entry.title));
        if (entry.dates) head.append(el("span", "askme-card-dates", entry.dates));
        card.append(head, el("p", "askme-card-statement", entry.statement));
        const links = (entry.evidence || []).filter((ev) => safeUrl(ev.url));
        if (links.length) {
          const row = el("div", "askme-card-evidence");
          for (const ev of links) {
            const a = el("a", null, ev.label);
            a.href = ev.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            row.append(a);
          }
          card.append(row);
        }
        list.append(card);
      }
      this.output.replaceChildren(el("p", "askme-intro", COPY.intro), list);
    }
  }

  function init() {
    document.querySelectorAll("[data-askme]").forEach((root) => new AskMe(root));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
