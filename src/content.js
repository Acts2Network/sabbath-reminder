/*
 * Sabbath Reminder — Gmail content script.
 *
 * Behaviour:
 *   - Acts on Monday ("e-sabbath"). The extension is intended to be installed
 *     only for the relevant org, so it does not gate on the account domain.
 *   - Intercepts the Gmail "Send" action (button click and Ctrl/Cmd+Enter).
 *   - Shows a modal offering three choices:
 *       1. Send anyway
 *       2. Schedule send (opens Gmail's native date & time picker)
 *       3. Cancel
 */
(function () {
  "use strict";

  // ----- Configuration -------------------------------------------------------

  // 0 = Sunday, 1 = Monday, ... 6 = Saturday.
  const SABBATH_DAY = 1; // Monday

  // ----- Small utilities -----------------------------------------------------

  function isSabbathToday() {
    return new Date().getDay() === SABBATH_DAY;
  }

  /** Wait until predicate returns a truthy value, or reject on timeout. */
  function waitFor(predicate, { timeout = 5000, interval = 80, label = "" } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        let result;
        try {
          result = predicate();
        } catch (_) {
          /* ignore and retry */
        }
        if (result) return resolve(result);
        if (Date.now() - start > timeout) {
          return reject(
            new Error("waitFor timed out" + (label ? ": " + label : ""))
          );
        }
        setTimeout(poll, interval);
      })();
    });
  }

  function normalizedText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // ----- Send-button detection ----------------------------------------------

  /** Is the given element (or an ancestor) the compose "Send" button? */
  function findSendButtonFrom(el) {
    if (!el || !el.closest) return null;
    const btn = el.closest(
      '[role="button"][data-tooltip], [role="button"][aria-label]'
    );
    if (!btn) return null;
    const label = (
      btn.getAttribute("data-tooltip") ||
      btn.getAttribute("aria-label") ||
      ""
    ).toLowerCase();
    // Match "Send" / "Send (Ctrl+Enter)" but not "More send options".
    if (/^send\b/.test(label) && !label.includes("more send")) {
      return btn;
    }
    return null;
  }

  /** Find the Send button inside a given compose context (for keyboard sends). */
  function findSendButtonIn(context) {
    const candidates = (context || document).querySelectorAll(
      '[role="button"][data-tooltip], [role="button"][aria-label]'
    );
    for (const btn of candidates) {
      const label = (
        btn.getAttribute("data-tooltip") ||
        btn.getAttribute("aria-label") ||
        ""
      ).toLowerCase();
      if (/^send\b/.test(label) && !label.includes("more send")) {
        return btn;
      }
    }
    return null;
  }

  // ----- "Schedule send" automation -----------------------------------------

  function findMoreSendOptions(sendBtn) {
    // The dropdown arrow is normally a sibling of the Send button.
    const scope = sendBtn.closest('[role="dialog"]') || document;
    const candidates = scope.querySelectorAll(
      '[role="button"][data-tooltip], [role="button"][aria-label]'
    );
    for (const btn of candidates) {
      const label = (
        btn.getAttribute("data-tooltip") ||
        btn.getAttribute("aria-label") ||
        ""
      ).toLowerCase();
      if (label.includes("more send options")) return btn;
    }
    return null;
  }

  /** Element is rendered with real size on screen (not a hidden/stale node). */
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * Gmail's menu items / buttons respond to the full pointer+mouse sequence,
   * not a bare click(). Dispatch at the element's on-screen centre so event
   * delegation and hit-testing both see a real target.
   */
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, base));
    }
  }

  /**
   * Return every visible element matching selector whose text contains `text`.
   * Used to disambiguate Gmail's many duplicate/stale menu nodes.
   */
  function visibleMatches(selector, text, root = document) {
    const target = text.toLowerCase();
    const out = [];
    for (const el of root.querySelectorAll(selector)) {
      const txt = normalizedText(el);
      if (txt === target || txt.includes(target)) {
        if (isVisible(el)) out.push(el);
      }
    }
    return out;
  }

  /**
   * Open Gmail's native "Schedule send" dialog, then hand control to the user:
   * they pick a preset or "Pick date & time" in Gmail's own dialog. We do not
   * fill or confirm anything. Depends on Gmail's DOM and is best-effort — if a
   * step can't be found we throw so the caller can surface a fallback hint.
   */
  async function openGmailSchedulePicker(sendBtn) {
    // The compose window is itself a [role="dialog"]; never treat it as a menu.
    const composeDialog = sendBtn.closest('[role="dialog"]') || null;

    const arrow = findMoreSendOptions(sendBtn);
    if (!arrow) throw new Error("Could not find the schedule-send dropdown");
    realClick(arrow);

    // Gmail keeps several stale/hidden "Schedule send" nodes in the DOM. Wait
    // for at least one that is actually visible on screen (i.e. in the menu the
    // arrow just opened), then click the one that is genuinely hit-testable.
    const candidates = await waitFor(
      () => {
        const m = visibleMatches('[role="menuitem"]', "schedule send");
        return m.length ? m : null;
      },
      { label: "schedule-send menuitem" }
    );
    // Prefer the candidate whose centre actually hit-tests to itself (the one
    // really on top / clickable), else fall back to the last match.
    let scheduleItem = candidates[candidates.length - 1];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) {
        scheduleItem = el;
        break;
      }
    }
    // Snapshot the dialogs that already exist so we can detect the NEW picker
    // dialog that opening "Schedule send" creates.
    const before = new Set(document.querySelectorAll('[role="dialog"]'));
    realClick(scheduleItem);

    // Wait for the schedule picker — a dialog that did not exist before — then
    // hand control to the user. We stop here: the user picks a preset or opens
    // "Pick date & time" themselves in Gmail's own dialog.
    await waitFor(
      () => {
        for (const dlg of document.querySelectorAll('[role="dialog"]')) {
          if (dlg === composeDialog || before.has(dlg)) continue;
          return dlg;
        }
        return null;
      },
      { label: "new picker dialog" }
    );
  }

  // ----- Modal ---------------------------------------------------------------

  let modalOpen = false;

  /**
   * Show the e-sabbath modal. Resolves with the chosen action:
   *   "send" | "schedule" | "cancel"
   */
  function showSabbathModal() {
    return new Promise((resolve) => {
      if (modalOpen) return resolve("cancel");
      modalOpen = true;

      const overlay = document.createElement("div");
      overlay.className = "sr-overlay";

      const box = document.createElement("div");
      box.className = "sr-modal";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "sr-title");

      box.innerHTML = [
        '<h2 id="sr-title" class="sr-title">Today is e-sabbath</h2>',
        '<p class="sr-body">Are you sure you want to send this email now?</p>',
        '<div class="sr-actions">',
        '  <button type="button" class="sr-btn sr-btn-primary" data-choice="send">Send anyway</button>',
        '  <button type="button" class="sr-btn sr-btn-secondary" data-choice="schedule">Schedule send</button>',
        '  <button type="button" class="sr-btn sr-btn-secondary" data-choice="cancel">Cancel</button>',
        "</div>",
      ].join("");

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function cleanup(choice) {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        modalOpen = false;
        resolve(choice);
      }

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cleanup("cancel");
        }
      }

      box.addEventListener("click", (e) => {
        const target = e.target.closest("[data-choice]");
        if (!target) return;
        cleanup(target.getAttribute("data-choice"));
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) cleanup("cancel");
      });
      document.addEventListener("keydown", onKey, true);

      // Focus the primary action for keyboard users.
      const primary = box.querySelector(".sr-btn-primary");
      if (primary) primary.focus();
    });
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "sr-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add("sr-toast-visible"), 10);
    setTimeout(() => {
      toast.classList.remove("sr-toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ----- Interception --------------------------------------------------------

  // When true, the next send action is allowed through without prompting.
  let bypassNextSend = false;

  async function handleSendIntercept(sendBtn) {
    const choice = await showSabbathModal();

    if (choice === "send") {
      bypassNextSend = true;
      sendBtn.click();
      return;
    }

    if (choice === "schedule") {
      try {
        await openGmailSchedulePicker(sendBtn);
      } catch (err) {
        console.warn("[Sabbath Reminder] Couldn't open scheduler:", err);
        showToast(
          "Couldn't open Gmail's scheduler. Use the Send dropdown's " +
            "“Schedule send” option."
        );
      }
      return;
    }

    // choice === "cancel": do nothing, email stays in the compose window.
  }

  function onClickCapture(e) {
    if (bypassNextSend) {
      // This is our own programmatic re-send; let it through once.
      bypassNextSend = false;
      return;
    }
    if (modalOpen) return;
    if (!isSabbathToday()) return;

    const sendBtn = findSendButtonFrom(e.target);
    if (!sendBtn) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSendIntercept(sendBtn);
  }

  function onKeydownCapture(e) {
    if (modalOpen) return;
    const isSendShortcut =
      (e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.keyCode === 13);
    if (!isSendShortcut) return;
    if (!isSabbathToday()) return;

    const compose = e.target.closest && e.target.closest('[role="dialog"]');
    const sendBtn = findSendButtonIn(compose || document);
    if (!sendBtn) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSendIntercept(sendBtn);
  }

  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKeydownCapture, true);
})();
