package drafts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRoundTripsJSONAsAlWritesIt(t *testing.T) {
	d := Draft{ID: "x", Workspace: "w1", Space: "dots", Cwd: "/tmp", Text: "look at [Image #1]\nand fix it", Images: []string{"/a/1.png"}, Created: 1, Kind: "codex", Config: "codex", Plan: true}
	for _, r := range []*ReplyTo{nil, {Pane: "w1:p3", Tab: "w1:t2", Label: "auth_tests"}} {
		d.Reply = r
		body, err := Encode([]Draft{d})
		if err != nil {
			t.Fatal(err)
		}
		back := parse(body)
		if len(back) != 1 || !back[0].Equal(d) {
			t.Fatalf("%s\n%#v", body, back)
		}
	}
	if !d.Belongs("w1", "") || !d.Belongs("w9", "dots") || d.Belongs("w9", "") {
		t.Fatal("belongs")
	}
}

func TestReadsTheRustFileAndWritesItTheSame(t *testing.T) {
	const rust = `{
  "drafts": [
    {
      "config": "codex(astra)",
      "created": 1700000000,
      "cwd": "/Users/example/projects/example",
      "id": "legacy-1",
      "images": [
        "/Users/example/.local/state/o/drafts/legacy-1/1.png"
      ],
      "kind": "codex",
      "plan": false,
      "reply": null,
      "space": "example",
      "text": "fix [Image #1] in <header> & \"footer\"",
      "workspace": "session:example"
    }
  ]
}`
	got, err := Encode(parse([]byte(rust)))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != rust {
		t.Fatalf("got\n%s", got)
	}
	// One with a reply, as al writes it.
	var v any
	_ = json.Unmarshal([]byte(`{"drafts":[{"id":"a","cwd":"/","text":"t","reply":{"pane":"block:1","tab":"","label":"auth","session":null}}]}`), &v)
	b, _ := json.Marshal(v)
	ds := parse(b)
	if len(ds) != 1 || ds[0].Reply == nil || ds[0].Reply.Label != "auth" || ds[0].Kind != "" {
		t.Fatalf("%#v", ds)
	}
}

func draft(cwd, text string, images ...string) Draft {
	return Draft{ID: text, Workspace: "w1", Cwd: cwd, Text: text, Images: images, Created: 1}
}

func TestCombinesDraftsNumberingTheirImagesAcrossThem(t *testing.T) {
	a := draft("/r", "fix [Image #2] and [Image #1]\n", "/a1.png", "/a2.png")
	b := draft("/r", "see [Image #1], again [Image #1], and [Image #3]", "/b1.png")
	text, images := Combine([]Draft{a, b})
	if !strings.HasPrefix(text, "Here are 2 tasks") || strings.Contains(text, elsewhere) {
		t.Fatal(text)
	}
	if !strings.HasSuffix(text, "## Task 1 of 2\n\nfix [Image #1] and [Image #2]\n\n## Task 2 of 2\n\nsee [Image #3], again [Image #3], and [missing image]") {
		t.Fatal(text)
	}
	if !reflect.DeepEqual(images, []string{"/a2.png", "/a1.png", "/b1.png"}) {
		t.Fatal(images)
	}
	c := draft("/elsewhere", "and this")
	text, _ = Combine([]Draft{a, c})
	if !strings.Contains(text, elsewhere) || !strings.Contains(text, "## Task 2 of 2 (in /elsewhere)\n\nand this") {
		t.Fatal(text)
	}
}

func TestTaggedListsTheImagesStillInTheText(t *testing.T) {
	got := TaggedImages("[Image #3] then [Image #1] [Image #3] [Image #9]", []string{"/1.png", "/2.png", "/3.png"})
	if !reflect.DeepEqual(got, []Tagged{{1, "/1.png"}, {3, "/3.png"}}) {
		t.Fatal(got)
	}
}

func TestPutRemoveAndKeepImages(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	src := filepath.Join(t.TempDir(), "paste.png")
	os.WriteFile(src, []byte("png"), 0o644)
	if err := Put(draft("/r", "one")); err != nil {
		t.Fatal(err)
	}
	d := draft("/r", "two [Image #1]", src)
	d.Images = KeepImages(d.ID, d.Text, d.Images)
	if !strings.HasPrefix(d.Images[0], ImageDir(d.ID)) {
		t.Fatal(d.Images)
	}
	Put(d)
	if all := Load(); len(all) != 2 || all[0].ID != "two [Image #1]" {
		t.Fatal(all)
	}
	Remove("one")
	if all := Load(); len(all) != 1 {
		t.Fatal(all)
	}
}
