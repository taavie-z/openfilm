---
"@openfilm/desktop": patch
---

Desktop on Windows: Codex starts for people who have the Codex app. OpenFilm used the codex.exe inside the app's Microsoft Store folder, which Windows lets no other program start ("Access is denied"); it now uses the copy the Codex app itself starts, in %LOCALAPPDATA%\OpenAI\Codex\bin, and never a program inside a Store app's folder.
