# Render:  vhs docs/v2/artifacts/tui/tapes/monitor.tape   (run from the repo root)
# Needs charmbracelet/vhs + ttyd installed, and a populated DB (`bun start` once).
Output docs/v2/artifacts/tui/monitor.gif
Set Shell "bash"
Set FontSize 13
Set Width 1500
Set Height 850
Set Padding 12

Type "bun run tui -- --no-ingest"  Enter
Sleep 2.5s
Screenshot docs/v2/artifacts/tui/monitor-01-table.png

# horizontal scroll — TIME stays frozen on the left
Right@300ms Right Right
Sleep 1.2s
Screenshot docs/v2/artifacts/tui/monitor-02-hscroll.png

# facet picker
Type "f"
Sleep 1.2s
Screenshot docs/v2/artifacts/tui/monitor-03-facets.png
Escape
Sleep 400ms

# detail drawer for the highlighted row
Enter
Sleep 1.2s
Screenshot docs/v2/artifacts/tui/monitor-04-drawer.png
Type "r"
Sleep 1s
Screenshot docs/v2/artifacts/tui/monitor-05-drawer-raw.png
Type "q"
Sleep 400ms

Type "q"
Sleep 800ms
