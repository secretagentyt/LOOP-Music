# Bot muzyczny na Discorda 🎵

Komendy: `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/volume`, `/queue`.

## Wdrożenie na Railway

1. Wgraj ten folder jako projekt na Railway.
2. W zakładce **Variables** dodaj `DISCORD_TOKEN` — token bota z Discord Developer Portal.
3. Deploy. Gotowe.

Wyszukiwanie po nazwie działa przez SoundCloud (bez logowania, bez blokad). Linki YouTube są obsługiwane przez `yt-dlp` (klient "android"), co znacznie rzadziej trafia na blokadę YouTube niż wcześniejsze rozwiązanie — jeśli mimo to się zdarzy, użyj linku SoundCloud albo samej nazwy utworu.
