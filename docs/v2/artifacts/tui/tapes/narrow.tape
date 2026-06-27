# Render:  vhs docs/v2/artifacts/tui/tapes/narrow.tape   (run from the repo root)
# A deliberately narrow (~80-col) terminal: ←/→ horizontal scroll + column-hide
# are how you reach off-screen columns when width is tight.
Output docs/v2/artifacts/tui/narrow.gif
Set Shell "bash"
Set FontSize 16
Set Width 720
Set Height 620
Set Padding 10

Type "bun run v2:tui -- --no-ingest"  Enter
Sleep 2.5s
Screenshot docs/v2/artifacts/tui/narrow-01-table.png

# scroll the non-frozen columns into view
Right@300ms Right Right Right
Sleep 1.2s
Screenshot docs/v2/artifacts/tui/narrow-02-hscroll.png

Type "q"
Sleep 800ms
