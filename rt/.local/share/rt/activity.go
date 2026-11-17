package main

import (
	"encoding/json"
	"time"
)

type pane struct {
	id, label string
}

type activity struct {
	BlockID   string    `json:"block_id"`
	State     string    `json:"state"`
	App       string    `json:"effective_app"`
	UpdatedAt time.Time `json:"updated_at"`
}

type activityGroup int

const (
	attention activityGroup = iota
	working
	done
	other
)

func (a activity) group() activityGroup {
	switch a.State {
	case "blocked", "error":
		return attention
	case "working":
		return working
	case "done":
		return done
	default:
		return other
	}
}

// Read status in one Rex connection. A record belongs to the program that
// reported it, so ignore records left behind by an old foreground process.
const activityScript = `
local records = {}
for session_id, block_ids in pairs(rex.args.panes) do
  if rex.call("session.attach", { session_id = session_id }) then
    for _, block_id in ipairs(block_ids) do
      local target = { session_id = session_id, block_id = block_id, method = "program_status" }
      local result = rex.call("block.method", target)
      local foreground
      for _, record in ipairs(result and result.records or {}) do
        if record.owner and not foreground then
          target.method = "process"
          foreground = (rex.call("block.method", target) or {}).foreground or {}
        end
        if not record.owner or (record.owner.pid == foreground.pid and record.owner.name == foreground.name) then
          record.block_id = block_id
          records[#records + 1] = record
          break
        end
      end
    end
  end
end
if #records == 0 then return nil end
return records
`

func (r *rexCLI) snapshot() (snapshot, error) {
	snap, err := r.listTabs()
	if err == nil {
		r.addActivity(&snap)
	}
	return snap, err
}

func (r *rexCLI) addActivity(snap *snapshot) {
	panes := make(map[string][]string)
	for _, t := range snap.Tabs {
		for _, p := range t.terminals {
			panes[t.SessionID] = append(panes[t.SessionID], p.id)
		}
	}
	if len(panes) == 0 {
		return
	}
	args, _ := json.Marshal(map[string]map[string][]string{"panes": panes})
	data, err := r.call("do", "-e", activityScript, "--args", string(args), "--json")
	var records []activity
	if err != nil || json.Unmarshal(data, &records) != nil {
		snap.activityUnavailable = true
		return
	}
	byPane := make(map[string]activity, len(records))
	for _, a := range records {
		byPane[a.BlockID] = a
	}
	for i := range snap.Tabs {
		t := &snap.Tabs[i]
		for _, p := range t.terminals {
			a, found := byPane[p.id]
			if !found {
				continue
			}
			if a.group() < t.activity.group() || (a.group() == t.activity.group() && a.UpdatedAt.After(t.activity.UpdatedAt)) {
				t.activity = a
				t.pane = p
			}
		}
	}
}
