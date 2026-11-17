package main

import (
	"slices"
	"testing"
)

func TestCommandNamesAndPassthrough(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		args, want   []string
	}{
		{"jv", "pr", []string{"42", "-R", "org/repo"}, []string{"42", "-R", "org/repo"}},
		{"jf", "pr", []string{"--", "--help"}, []string{"--help"}},
		{"jg", "git", []string{"-s", "--", "name with spaces"}, []string{"-s", "--", "name with spaces"}},
		{"jg", "git", nil, nil},
		{"jp", "pr", []string{"-o", "review-requested:@me"}, []string{"-o", "review-requested:@me"}},
		{"jn", "pr", []string{"12", "45"}, []string{"12", "45"}},
		{"jv", "git", []string{"42", ".", "-g", "--help"}, []string{"--help"}},
		{"jv", "cmd", []string{"-c", "git diff HEAD", "-g", "main..."}, []string{"git diff HEAD"}},
		{"jv", "local", []string{"42", "."}, nil},
	} {
		got, err := parse(aliasArgs(tc.name, tc.args))
		if err != nil {
			t.Fatal(err)
		}
		if got.action != "" || got.source != tc.source || !slices.Equal(got.args, tc.want) ||
			got.view.Flat != (tc.name == "jf") || got.view.PRs != (tc.name == "jp") || got.view.Net != (tc.name == "jn") {
			t.Errorf("%s %q: got %+v, want %s %q", tc.name, tc.args, got, tc.source, tc.want)
		}
	}
}

func TestViewerOptions(t *testing.T) {
	t.Setenv("JV_THEME", "TwoDark")
	c, err := parse([]string{"--split", "-u", "--tests", "--no-tests", "--no-wrap", "--popup", "--snapshot", "100x24", "--keys", "t", "--out", "my diff.html"})
	if err != nil {
		t.Fatal(err)
	}
	v := c.view
	if v.Split == nil || *v.Split || v.Tests == nil || *v.Tests || v.Wrap || !v.Popup ||
		v.Snapshot == nil || *v.Snapshot != [2]uint16{100, 24} || v.Keys != "t" ||
		v.Out == nil || *v.Out != "my diff.html" || v.Theme == nil || *v.Theme != "TwoDark" {
		t.Fatalf("wrong viewer options: %+v", v)
	}
	c, err = parse([]string{"--theme=GitHub", "--prs", "--help", "-g"})
	if err != nil || c.action != "help" || !c.view.PRs || c.view.Theme == nil || *c.view.Theme != "GitHub" {
		t.Fatalf("help or theme override: %+v, %v", c, err)
	}
	for _, args := range [][]string{{"-c"}, {"--theme"}, {"--snapshot", "80"}, {"--snapshot", "80x65536"}} {
		if _, err := parse(args); err == nil {
			t.Errorf("accepted invalid options %q", args)
		}
	}
}
