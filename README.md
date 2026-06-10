# Sabbath Reminder

A Chrome extension that reminds you that **Monday is e-sabbath** before you send
an email in Gmail.

## What it does

When you click **Send** (or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>)
in Gmail on a **Monday** (the e-sabbath), sending is paused and a dialog appears:

![Sabbath Reminder modal](docs/screenshot-v2.png)

You can choose:

- **Send anyway** — sends the email immediately.
- **Schedule send** — pick any date and time (defaults to tomorrow at 8:00 AM
  local), then uses Gmail's built-in *Schedule send* to deliver it then.
- **Cancel** — does nothing; the email stays in the compose window.

On any other day the extension stays completely out of the way. It applies to
every account in the browser, so install it only where the reminder is wanted.

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

The reminder appears whenever you send mail on a **Monday**.

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

| Constant          | Default          | Meaning                                  |
| ----------------- | ---------------- | ---------------------------------------- |
| `SABBATH_DAY`     | `1` (Monday)     | Day of week for the e-sabbath (0 = Sun). |
| `SCHEDULE_HOUR`   | `8`              | Default hour pre-filled in the picker.   |
| `SCHEDULE_MINUTE` | `0`              | Default minute pre-filled in the picker. |

## Files

```
manifest.json      # MV3 manifest
src/content.js     # interception + modal + scheduling logic
src/modal.css      # modal & toast styling
icons/             # extension icons
```

## Notes & limitations

- The **Schedule send** option drives Gmail's native *Schedule send* dialog
  through the DOM. Keeping the default (tomorrow at 8:00 AM) clicks Gmail's
  *Tomorrow morning* preset; any other time is typed into Gmail's custom date &
  time picker. Gmail's markup changes frequently; if auto-scheduling fails, the
  extension leaves the scheduling dialog open and shows a toast so you can pick a
  time manually.
- The reminder fires for **every** Gmail account in the browser. Install it only
  where the e-sabbath reminder is wanted.
