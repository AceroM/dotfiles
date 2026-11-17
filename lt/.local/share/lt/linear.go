package main

// Linear's GraphQL API, with $LINEAR_API_KEY. lt reads one scope's open issues (yours, the
// ones you created, or a team's), and changes them: status, priority, assignee and title in
// batches of up to 50, delete (Linear's trash, 30 days) and restore, create. The last list of
// each scope is cached in ~/.cache/lt so lt draws at once and refreshes behind.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const endpoint = "https://api.linear.app/graphql"

// Linear's state types, in the order the status picker numbers them (triage 0 … duplicate).
var stateTypes = []string{"triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"}

// Done, canceled and duplicate issues aren't listed (unless you touched them this session).
var closedTypes = []string{"completed", "canceled", "duplicate"}

type state struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Position float64 `json:"position"`
}

func (s state) closed() bool {
	for _, t := range closedTypes {
		if s.Type == t {
			return true
		}
	}
	return false
}

// typeRank is the state type's place in stateTypes (picker order).
func (s state) typeRank() int {
	for i, t := range stateTypes {
		if s.Type == t {
			return i
		}
	}
	return len(stateTypes)
}

type team struct {
	ID     string  `json:"id"`
	Key    string  `json:"key"`
	Name   string  `json:"name"`
	States []state `json:"states"`
	// You're a member: the team gets a scope.
	Mine bool `json:"mine"`
}

// sortedStates is the team's workflow in picker order: by type, then the team's own order.
func (t team) sortedStates() []state {
	out := append([]state(nil), t.States...)
	sort.SliceStable(out, func(a, b int) bool {
		if ra, rb := out[a].typeRank(), out[b].typeRank(); ra != rb {
			return ra < rb
		}
		return out[a].Position < out[b].Position
	})
	return out
}

type person struct {
	ID   string `json:"id"`
	Name string `json:"displayName"`
	Full string `json:"name,omitempty"`
}

type issue struct {
	ID         string    `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	URL        string    `json:"url"`
	Branch     string    `json:"branch"`
	Priority   int       `json:"priority"`
	Created    time.Time `json:"created"`
	Updated    time.Time `json:"updated"`
	State      state     `json:"state"`
	TeamID     string    `json:"teamId"`
	Assignee   *person   `json:"assignee,omitempty"`
	Project    string    `json:"project,omitempty"`
	Labels     []string  `json:"labels,omitempty"`
}

func (i issue) assigneeID() string {
	if i.Assignee == nil {
		return ""
	}
	return i.Assignee.ID
}

// matches: every word is in the identifier, title, status, project, labels or assignee.
func (i issue) matches(words []string) bool {
	if len(words) == 0 {
		return true
	}
	hay := strings.ToLower(strings.Join(append([]string{i.Identifier, i.Title, i.State.Name, i.Project, priorityName(i.Priority)}, i.Labels...), " "))
	if i.Assignee != nil {
		hay += " " + strings.ToLower(i.Assignee.Name)
	}
	for _, w := range words {
		if !strings.Contains(hay, w) {
			return false
		}
	}
	return true
}

// priorityName is Linear's own name for 0 … 4.
func priorityName(p int) string {
	switch p {
	case 1:
		return "Urgent"
	case 2:
		return "High"
	case 3:
		return "Medium"
	case 4:
		return "Low"
	}
	return "No priority"
}

// meta is who you are and every team you can see, with its workflow states.
type meta struct {
	Viewer person `json:"viewer"`
	Teams  []team `json:"teams"`
}

func (m meta) team(id string) (team, bool) {
	for _, t := range m.Teams {
		if t.ID == id {
			return t, true
		}
	}
	return team{}, false
}

func (m meta) teamKey(id string) string {
	if t, ok := m.team(id); ok {
		return t.Key
	}
	return "?"
}

type scopeKind int

const (
	scopeMine scopeKind = iota
	scopeCreated
	scopeTeam
)

type scope struct {
	Kind scopeKind
	Team team
}

func (s scope) key() string {
	switch s.Kind {
	case scopeCreated:
		return "created"
	case scopeTeam:
		return "team-" + s.Team.Key
	}
	return "mine"
}

func (s scope) String() string {
	switch s.Kind {
	case scopeCreated:
		return "created by me"
	case scopeTeam:
		return s.Team.Key + " · " + s.Team.Name
	}
	return "my issues"
}

// scopes: yours, the ones you created, then each of your teams.
func (m meta) scopes() []scope {
	out := []scope{{Kind: scopeMine}, {Kind: scopeCreated}}
	for _, t := range m.Teams {
		if t.Mine {
			out = append(out, scope{Kind: scopeTeam, Team: t})
		}
	}
	return out
}

// api is what lt needs from Linear (the HTTP client; a fake in tests).
type api interface {
	meta() (meta, error)
	issues(s scope) ([]issue, error)
	people() ([]person, error)
	description(id string) (string, error)
	// update applies the same input to every issue (Linear's IssueUpdateInput: stateId,
	// priority, assigneeId, title, …) and returns them as they are now.
	update(ids []string, input map[string]any) ([]issue, error)
	// remove moves issues to Linear's trash; restore takes them back out.
	remove(ids []string) error
	restore(ids []string) error
	create(input map[string]any) (issue, error)
	comment(id, body string) error
}

type client struct {
	auth string
	http *http.Client
}

func newClient() (*client, error) {
	key := strings.TrimSpace(os.Getenv("LINEAR_API_KEY"))
	if key == "" {
		return nil, errors.New("LINEAR_API_KEY is not set (a personal API key: Linear → Settings → Security & access)")
	}
	// Personal keys go bare; OAuth tokens need Bearer.
	if !strings.HasPrefix(key, "lin_api_") && !strings.HasPrefix(strings.ToLower(key), "bearer ") {
		key = "Bearer " + key
	}
	return &client{auth: key, http: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (c *client) do(query string, vars map[string]any, out any) error {
	body, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", c.auth)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("linear: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("linear: %w", err)
	}
	var env struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message    string `json:"message"`
			Extensions struct {
				UserMessage string `json:"userPresentableMessage"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("linear: HTTP %d", resp.StatusCode)
	}
	if len(env.Errors) > 0 {
		e := env.Errors[0]
		if e.Extensions.UserMessage != "" {
			return errors.New(e.Extensions.UserMessage)
		}
		return errors.New(e.Message)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("linear: HTTP %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

const issueFields = `id identifier title url branchName priority createdAt updatedAt
state { id name type position } team { id } assignee { id displayName name }
project { name } labels(first: 10) { nodes { name } }`

type rawIssue struct {
	ID         string    `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	URL        string    `json:"url"`
	BranchName string    `json:"branchName"`
	Priority   int       `json:"priority"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	State      state     `json:"state"`
	Team       struct {
		ID string `json:"id"`
	} `json:"team"`
	Assignee *person `json:"assignee"`
	Project  *struct {
		Name string `json:"name"`
	} `json:"project"`
	Labels struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
}

func (r rawIssue) issue() issue {
	i := issue{
		ID: r.ID, Identifier: r.Identifier, Title: r.Title, URL: r.URL, Branch: r.BranchName,
		Priority: r.Priority, Created: r.CreatedAt, Updated: r.UpdatedAt, State: r.State,
		TeamID: r.Team.ID, Assignee: r.Assignee,
	}
	if r.Project != nil {
		i.Project = r.Project.Name
	}
	for _, l := range r.Labels.Nodes {
		i.Labels = append(i.Labels, l.Name)
	}
	return i
}

func (c *client) meta() (meta, error) {
	var out struct {
		Viewer struct {
			ID    string `json:"id"`
			Name  string `json:"displayName"`
			Full  string `json:"name"`
			Teams struct {
				Nodes []struct {
					ID string `json:"id"`
				} `json:"nodes"`
			} `json:"teams"`
		} `json:"viewer"`
		Teams struct {
			Nodes []struct {
				ID     string `json:"id"`
				Key    string `json:"key"`
				Name   string `json:"name"`
				States struct {
					Nodes []state `json:"nodes"`
				} `json:"states"`
			} `json:"nodes"`
		} `json:"teams"`
	}
	err := c.do(`query {
  viewer { id displayName name teams(first: 100) { nodes { id } } }
  teams(first: 100) { nodes { id key name states(first: 25) { nodes { id name type position } } } }
}`, nil, &out)
	if err != nil {
		return meta{}, err
	}
	mine := map[string]bool{}
	for _, t := range out.Viewer.Teams.Nodes {
		mine[t.ID] = true
	}
	m := meta{Viewer: person{ID: out.Viewer.ID, Name: out.Viewer.Name, Full: out.Viewer.Full}}
	for _, t := range out.Teams.Nodes {
		m.Teams = append(m.Teams, team{ID: t.ID, Key: t.Key, Name: t.Name, States: t.States.Nodes, Mine: mine[t.ID]})
	}
	sort.SliceStable(m.Teams, func(a, b int) bool { return m.Teams[a].Key < m.Teams[b].Key })
	return m, nil
}

// Most issues one scope lists (pages of 250, most recently updated first).
const maxIssues = 2000

func (c *client) issues(s scope) ([]issue, error) {
	filter := map[string]any{"state": map[string]any{"type": map[string]any{"nin": closedTypes}}}
	var conn string
	switch s.Kind {
	case scopeMine:
		conn = "viewer { assignedIssues(first: 250, after: $after, filter: $filter, orderBy: updatedAt) { %s } }"
	case scopeCreated:
		conn = "viewer { createdIssues(first: 250, after: $after, filter: $filter, orderBy: updatedAt) { %s } }"
	default:
		filter["team"] = map[string]any{"id": map[string]any{"eq": s.Team.ID}}
		conn = "issues(first: 250, after: $after, filter: $filter, orderBy: updatedAt) { %s }"
	}
	q := "query($after: String, $filter: IssueFilter) { " +
		fmt.Sprintf(conn, "nodes { "+issueFields+" } pageInfo { hasNextPage endCursor }") + " }"
	type page struct {
		Nodes    []rawIssue `json:"nodes"`
		PageInfo struct {
			HasNextPage bool   `json:"hasNextPage"`
			EndCursor   string `json:"endCursor"`
		} `json:"pageInfo"`
	}
	var all []issue
	var after any
	for len(all) < maxIssues {
		var out struct {
			Viewer struct {
				Assigned page `json:"assignedIssues"`
				Created  page `json:"createdIssues"`
			} `json:"viewer"`
			Issues page `json:"issues"`
		}
		if err := c.do(q, map[string]any{"after": after, "filter": filter}, &out); err != nil {
			return nil, err
		}
		p := out.Issues
		switch s.Kind {
		case scopeMine:
			p = out.Viewer.Assigned
		case scopeCreated:
			p = out.Viewer.Created
		}
		for _, r := range p.Nodes {
			all = append(all, r.issue())
		}
		if !p.PageInfo.HasNextPage {
			break
		}
		after = p.PageInfo.EndCursor
	}
	return all, nil
}

func (c *client) people() ([]person, error) {
	var out struct {
		Users struct {
			Nodes []struct {
				person
				Active bool `json:"active"`
				App    bool `json:"app"`
			} `json:"nodes"`
		} `json:"users"`
	}
	if err := c.do(`query { users(first: 250) { nodes { id displayName name active app } } }`, nil, &out); err != nil {
		return nil, err
	}
	var ps []person
	for _, u := range out.Users.Nodes {
		if u.Active && !u.App {
			ps = append(ps, u.person)
		}
	}
	return ps, nil
}

func (c *client) description(id string) (string, error) {
	var out struct {
		Issue struct {
			Description string `json:"description"`
		} `json:"issue"`
	}
	err := c.do(`query($id: String!) { issue(id: $id) { description } }`, map[string]any{"id": id}, &out)
	return out.Issue.Description, err
}

// Linear takes up to 50 issues per batch update.
const batchSize = 50

func (c *client) update(ids []string, input map[string]any) ([]issue, error) {
	var all []issue
	for start := 0; start < len(ids); start += batchSize {
		chunk := ids[start:min(len(ids), start+batchSize)]
		var out struct {
			Batch struct {
				Issues []rawIssue `json:"issues"`
			} `json:"issueBatchUpdate"`
		}
		err := c.do(`mutation($ids: [UUID!]!, $input: IssueUpdateInput!) {
  issueBatchUpdate(ids: $ids, input: $input) { issues { `+issueFields+` } }
}`, map[string]any{"ids": chunk, "input": input}, &out)
		if err != nil {
			return all, err
		}
		for _, r := range out.Batch.Issues {
			all = append(all, r.issue())
		}
	}
	return all, nil
}

// each runs one mutation per id, up to 50 per request (as aliases).
func (c *client) each(field string, ids []string) error {
	for start := 0; start < len(ids); start += batchSize {
		chunk := ids[start:min(len(ids), start+batchSize)]
		var params, body []string
		vars := map[string]any{}
		for i, id := range chunk {
			params = append(params, fmt.Sprintf("$i%d: String!", i))
			body = append(body, fmt.Sprintf("m%d: %s(id: $i%d) { success }", i, field, i))
			vars[fmt.Sprintf("i%d", i)] = id
		}
		q := "mutation(" + strings.Join(params, ", ") + ") { " + strings.Join(body, " ") + " }"
		if err := c.do(q, vars, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *client) remove(ids []string) error  { return c.each("issueDelete", ids) }
func (c *client) restore(ids []string) error { return c.each("issueUnarchive", ids) }

func (c *client) create(input map[string]any) (issue, error) {
	var out struct {
		Create struct {
			Issue rawIssue `json:"issue"`
		} `json:"issueCreate"`
	}
	err := c.do(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { `+issueFields+` } } }`,
		map[string]any{"input": input}, &out)
	if err != nil {
		return issue{}, err
	}
	return out.Create.Issue.issue(), nil
}

func (c *client) comment(id, body string) error {
	var out struct {
		Create struct {
			Success bool `json:"success"`
		} `json:"commentCreate"`
	}
	err := c.do(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
		map[string]any{"input": map[string]string{"issueId": id, "body": body}}, &out)
	if err != nil {
		return err
	}
	if !out.Create.Success {
		return errors.New("Linear didn't confirm the comment")
	}
	return nil
}

// The cache: the last meta and each scope's last list, so lt draws before the network answers.

func cacheDir() string {
	dir := os.Getenv("XDG_CACHE_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".cache")
	}
	return filepath.Join(dir, "lt")
}

func readCache(name string, v any) bool {
	data, err := os.ReadFile(filepath.Join(cacheDir(), name+".json"))
	return err == nil && json.Unmarshal(data, v) == nil
}

// writeCache is best effort: written to a temp file and renamed, readable by you only.
func writeCache(name string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	dir := cacheDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, name+".*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), filepath.Join(dir, name+".json")) != nil {
		_ = os.Remove(tmp.Name())
	}
}
