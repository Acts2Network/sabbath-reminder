/*
 * Sabbath Reminder — Gmail content script.
 *
 * Behaviour:
 *   - Only acts when the logged-in account belongs to the configured domain
 *     (acts2.network) AND today is Monday ("e-sabbath").
 *   - Intercepts the Gmail "Send" action (button click and Ctrl/Cmd+Enter).
 *   - Shows a modal offering three choices:
 *       1. Send anyway
 *       2. Schedule for tomorrow (drives Gmail's native "Schedule send")
 *       3. Cancel
 */
(function () {
  "use strict";

  // ----- Configuration -------------------------------------------------------

  const SABBATH_DOMAIN = "acts2.network";
  // 0 = Sunday, 1 = Monday, ... 6 = Saturday.
  const SABBATH_DAY = 1; // Monday
  // When scheduling for "the next day", send at this local time.
  const SCHEDULE_HOUR = 8; // 8 AM
  const SCHEDULE_MINUTE = 0;

  // ----- Small utilities -----------------------------------------------------

  function isSabbathToday() {
    return new Date().getDay() === SABBATH_DAY;
  }

  /**
   * Best-effort detection of the currently active Gmail account address.
   * Tries several sources because Gmail's DOM changes frequently.
   */
  function getActiveAccountEmail() {
    const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

    // 1. The document title is usually "<folder> - <email> - Gmail".
    const titleMatch = document.title && document.title.match(emailRe);
    if (titleMatch) return titleMatch[0].toLowerCase();

    // 2. The account switcher button exposes "Google Account: Name (email)".
    const accountBtn = document.querySelector(
      'a[aria-label*="Google Account"], [aria-label*="Google Account"]'
    );
    if (accountBtn) {
      const label = accountBtn.getAttribute("aria-label") || "";
      const m = label.match(emailRe);
      if (m) return m[0].toLowerCase();
    }

    // 3. Any element whose title looks like an email (profile photo, etc.).
    const titled = document.querySelector('[title*="@"]');
    if (titled) {
      const m = (titled.getAttribute("title") || "").match(emailRe);
      if (m) return m[0].toLowerCase();
    }

    return null;
  }

  function isSabbathAccount() {
    const email = getActiveAccountEmail();
    return !!email && email.endsWith("@" + SABBATH_DOMAIN.toLowerCase());
  }

  /** Wait until predicate returns a truthy value, or reject on timeout. */
  function waitFor(predicate, { timeout = 5000, interval = 80 } = {}) {
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
          return reject(new Error("waitFor timed out"));
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

  function setNativeInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

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

  function findByText(selector, text) {
    const target = text.toLowerCase();
    for (const el of document.querySelectorAll(selector)) {
      if (normalizedText(el) === target || normalizedText(el).includes(target)) {
        return el;
      }
    }
    return null;
  }

  function nextDayAtScheduleTime() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(SCHEDULE_HOUR, SCHEDULE_MINUTE, 0, 0);
    return d;
  }

  /**
   * Drive Gmail's native "Schedule send" dialog to schedule for tomorrow.
   * This depends on Gmail's DOM and is best-effort: if any step fails we leave
   * the scheduling dialog open so the user can finish manually.
   */
  async function scheduleForNextDay(sendBtn) {
    const arrow = findMoreSendOptions(sendBtn);
    if (!arrow) throw new Error("Could not find the schedule-send dropdown");
    arrow.click();

    const scheduleItem = await waitFor(() =>
      findByText('[role="menuitem"]', "schedule send")
    );
    scheduleItem.click();

    // Some Gmail variants jump straight to a presets dialog with a
    // "Pick date & time" entry; click through to the custom picker.
    try {
      const pick = await waitFor(
        () => findByText('[role="button"], button, span', "pick date & time"),
        { timeout: 1500 }
      );
      pick.click();
    } catch (_) {
      /* Custom picker may already be visible. */
    }

    const dialog = await waitFor(() => {
      const dlgs = document.querySelectorAll('[role="dialog"]');
      return dlgs.length ? dlgs[dlgs.length - 1] : null;
    });

    const inputs = await waitFor(() => {
      const found = dialog.querySelectorAll('input[type="text"], input:not([type])');
      return found.length >= 2 ? found : null;
    });

    const target = nextDayAtScheduleTime();
    const dateStr = target.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const timeStr = target.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });

    // Identify date vs time inputs by aria-label when possible.
    let dateInput = null;
    let timeInput = null;
    for (const input of inputs) {
      const label = (input.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("date")) dateInput = input;
      if (label.includes("time")) timeInput = input;
    }
    if (!dateInput || !timeInput) {
      dateInput = dateInput || inputs[0];
      timeInput = timeInput || inputs[1];
    }

    setNativeInputValue(dateInput, dateStr);
    setNativeInputValue(timeInput, timeStr);
    dateInput.dispatchEvent(new Event("blur", { bubbles: true }));
    timeInput.dispatchEvent(new Event("blur", { bubbles: true }));

    const confirm = await waitFor(() => {
      const scope = dialog;
      for (const el of scope.querySelectorAll('[role="button"], button')) {
        if (normalizedText(el).includes("schedule send")) return el;
      }
      return null;
    });
    confirm.click();
  }

  // ----- Modal ---------------------------------------------------------------

  let modalOpen = false;

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
        '<p class="sr-body">Today is Monday, our e-sabbath. Are you sure you ',
        "want to send this email now?</p>",
        '<div class="sr-actions">',
        '  <button type="button" class="sr-btn sr-btn-primary" data-choice="send">Send anyway</button>',
        '  <button type="button" class="sr-btn sr-btn-secondary" data-choice="schedule">Schedule for tomorrow</button>',
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
        await scheduleForNextDay(sendBtn);
        showToast("Email scheduled to send tomorrow morning.");
      } catch (err) {
        console.warn("[Sabbath Reminder] Auto-scheduling failed:", err);
        showToast(
          "Couldn't auto-schedule. Please pick a time in the dialog that opened."
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
    if (!isSabbathToday() || !isSabbathAccount()) return;

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
    if (!isSabbathToday() || !isSabbathAccount()) return;

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
