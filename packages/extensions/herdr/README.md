# Herdr workflow extension

This repo-local extension is enabled when Pi is running in a Herdr-managed pane. It adds one `/workflow` agent action, `Open live session in Herdr pane`.

Set fully inspectable mode in the global workflow settings file (`~/.pi/agent/pi-extensible-workflows/settings.json`):

```json
{ "extensions": { "herdr": { "enableFullyInspectableMode": true } } }
```

Fully inspectable mode launches each workflow agent in a dedicated labeled Herdr workspace and hides the manual action.

Live handoff pauses the local SDK at a turn boundary. Pane exit, `/quit`, or a pane that returns idle after Herdr has observed it working returns ownership to the local SDK. The monitor relies on Herdr's built-in Pi screen detection and therefore cannot distinguish an aborted turn from a completed one. In Pi's default keybindings, interrupt is `Escape`; use double-`Escape` to abort a turn. A single `Ctrl-C` clears the editor and double-`Ctrl-C` exits Pi, so `Ctrl-C` is not a handback signal. Lifecycle reports from this extension are advisory when Herdr's built-in Pi integration has authority. Inline extension factories are materialized as temporary explicit extensions in the Herdr pane.