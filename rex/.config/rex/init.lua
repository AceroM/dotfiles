-- Rex config. Reload with: rex config reload

-- Tabs: cmd+option+left/right move between tabs.
rex.bind("cmd+alt+left", "client.tab.previous")
rex.bind("cmd+alt+right", "client.tab.next")

-- Panes: option+arrows move focus between panes.
rex.bind("alt+left", "pane.focus.left")
rex.bind("alt+right", "pane.focus.right")
rex.bind("alt+up", "pane.focus.up")
rex.bind("alt+down", "pane.focus.down")

-- cmd+n opens a new tab (instead of a new window).
rex.bind("cmd+n", "client.tab.new")

-- cmd+shift+n opens a new session.
rex.bind("cmd+shift+n", "session.new")

-- cmd+y copies the ID of the focused pane (instead of Quick Look).
rex.bind("cmd+y", "pane.copy_id")
