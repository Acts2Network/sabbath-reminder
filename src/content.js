/*
 * Sabbath Reminder — Gmail content script.
 *
 * Behaviour:
 *   - Acts on Monday ("e-sabbath"). The extension is intended to be installed
 *     only for the relevant org, so it does not gate on the account domain.
 *   - Intercepts the Gmail "Send" action (button click and Ctrl/Cmd+Enter).
 *   - Shows a modal offering three choices:
 *       1. Send anyway
 *       2. Schedule for tomorrow (drives Gmail's native "Schedule send")
 *       3. Cancel
 */
(function () {
  "use strict";

  // ----- Configuration -------------------------------------------------------

  // 0 = Sunday, 1 = Monday, ... 6 = Saturday.
  const SABBATH_DAY = 1; // Monday
  // When scheduling for "the next day", send at this local time.
  const SCHEDULE_HOUR = 8; // 8 AM
  const SCHEDULE_MINUTE = 0;

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

  function findByText(selector, text, root = document) {
    const target = text.toLowerCase();
    for (const el of root.querySelectorAll(selector)) {
      if (!isVisible(el)) continue; // skip hidden/stale nodes
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
    // The compose window is itself a [role="dialog"]. Capture it so we never
    // mistake it for the schedule picker and type the date/time into its
    // To/Subject fields.
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

    // Wait for the schedule picker — a dialog that did not exist before.
    const picker = await waitFor(
      () => {
        for (const dlg of document.querySelectorAll('[role="dialog"]')) {
          if (dlg === composeDialog || before.has(dlg)) continue;
          return dlg;
        }
        return null;
      },
      { label: "new picker dialog" }
    );

    // Preferred path: click Gmail's built-in "Tomorrow morning" preset, which
    // schedules tomorrow at 8:00 AM and matches the default schedule time. This
    // avoids typing into date/time fields entirely — the source of the bug
    // where text leaked into the compose Subject. The picker content can load
    // a beat after the dialog appears, so poll for it.
    if (SCHEDULE_HOUR === 8 && SCHEDULE_MINUTE === 0) {
      try {
        const preset = await waitFor(
          () =>
            findByText(
              '[role="menuitem"], [role="button"], [role="option"], li',
              "tomorrow morning",
              picker
            ),
          { timeout: 2500, label: "tomorrow-morning preset" }
        );
        realClick(preset);
        return;
      } catch (_) {
        console.warn(
          "[Sabbath Reminder] no 'tomorrow morning' preset; picker text:",
          normalizedText(picker).slice(0, 200)
        );
      }
    }

    // Fallback: open Gmail's custom date & time picker.
    const pick = findByText(
      '[role="button"], button, span',
      "pick date & time",
      picker
    );
    if (pick) realClick(pick);

    // Find the custom-picker dialog (again, never the compose window) by
    // requiring it to contain BOTH an aria-labelled date and time input. If we
    // can't positively identify them, abort and let the user finish manually
    // rather than risk editing the email.
    const customDialog = await waitFor(
      () => {
        for (const dlg of document.querySelectorAll('[role="dialog"]')) {
          if (dlg === composeDialog) continue;
          const hasDate = dlg.querySelector('input[aria-label*="ate" i]');
          const hasTime = dlg.querySelector('input[aria-label*="ime" i]');
          if (hasDate && hasTime) return dlg;
        }
        return null;
      },
      { label: "custom date/time dialog" }
    );

    const dateInput = customDialog.querySelector('input[aria-label*="ate" i]');
    const timeInput = customDialog.querySelector('input[aria-label*="ime" i]');
    if (!dateInput || !timeInput) {
      throw new Error("Could not identify the date/time fields");
    }

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

    setNativeInputValue(dateInput, dateStr);
    setNativeInputValue(timeInput, timeStr);
    dateInput.dispatchEvent(new Event("blur", { bubbles: true }));
    timeInput.dispatchEvent(new Event("blur", { bubbles: true }));

    const confirm = await waitFor(
      () => {
        for (const el of customDialog.querySelectorAll('[role="button"], button')) {
          if (normalizedText(el).includes("schedule send")) return el;
        }
        return null;
      },
      { label: "confirm schedule-send button" }
    );
    realClick(confirm);
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
