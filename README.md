# Sabbath Reminder

A Chrome extension that reminds **acts2.network** Gmail users that **Monday is
e-sabbath** before they send an email.

## What it does

When you click **Send** (or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>)
in Gmail, the extension checks two things:

1. Is today **Monday** (the e-sabbath)?
2. Is the active Gmail account on the **`acts2.network`** domain?

If both are true, sending is paused and a dialog appears:

![Sabbath Reminder modal](docs/screenshot.png)

You can choose:

- **Send anyway** — sends the email immediately.
- **Schedule for tomorrow** — uses Gmail's built-in *Schedule send* to send the
  email tomorrow at 8:00 AM (local time).
- **Cancel** — does nothing; the email stays in the compose window.

On any other day, or for accounts outside `acts2.network`, the extension stays
completely out of the way.

## Install (load unpacked)

Chrome has no build step for this extension — it loads the source directly.

1. **Get the code.** Clone the repo (or download the ZIP from GitHub and
   unzip it):

   ```bash
   git clone git@github.com:Acts2Network/sabbath-reminder.git
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the `sabbath-reminder` folder (the one
   containing `manifest.json`).
5. Open [Gmail](https://mail.google.com). If you're not already on it, reload
   the tab so the extension loads.

The reminder appears when you send mail on a **Monday** from an
**`acts2.network`** account.

### Updating

After pulling new changes (`git pull`), go to `chrome://extensions`, click the
**reload** ↻ icon on the Sabbath Reminder card, then reload your Gmail tab.

### Notes

- Keep the unpacked folder where it is — Chrome loads the extension from that
  path on every launch. Deleting or moving it removes the extension.
- "Developer mode" extensions are normal for internal tools. For org-wide
  rollout without manual steps, see the Chrome Web Store (unlisted) or Google
  Workspace admin force-install options.

## Configuration

The defaults live at the top of [`src/content.js`](src/content.js):

| Constant          | Default          | Meaning                                    |
| ----------------- | ---------------- | ------------------------------------------ |
| `SABBATH_DOMAIN`  | `acts2.network`  | Only accounts on this domain are reminded. |
| `SABBATH_DAY`     | `1` (Monday)     | Day of week for the e-sabbath (0 = Sun).   |
| `SCHEDULE_HOUR`   | `8`              | Hour to schedule "tomorrow" sends.         |
| `SCHEDULE_MINUTE` | `0`              | Minute to schedule "tomorrow" sends.       |

## Files

```
manifest.json      # MV3 manifest
src/content.js     # interception + modal + scheduling logic
src/modal.css      # modal & toast styling
icons/             # extension icons
```

## Notes & limitations

- The "Schedule for tomorrow" option drives Gmail's native *Schedule send*
  dialog through the DOM. Gmail's markup changes frequently; if auto-scheduling
  fails, the extension leaves the scheduling dialog open and shows a toast so
  you can pick a time manually.
- The active account is detected from the page title / account switcher. If you
  use multiple accounts in one window, make sure the correct account is active.
