---
"pi-pigment": patch
---

Fix the bash wrapper silently dropping pi's shell settings. Registering the pigment bash tool under the same name replaces pi's builtin definition wholesale, execute included, so the wrapper now reads the same `SettingsManager` pi itself uses and passes `commandPrefix`/`shellPath` into `createBashToolDefinition` — a configured shell or command prefix runs again. The read is gated on the project trust pi resolved, matching pi's own manager: an untrusted project's `.pi/settings.json` must not shape the command that runs.
