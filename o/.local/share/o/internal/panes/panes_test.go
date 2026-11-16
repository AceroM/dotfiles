package panes

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"o/internal/drafts"
)

func TestNamesABlocksFile(t *testing.T) {
	f := File("block:01a1d24d-dbd4-7274-99c2-c50db953ded1")
	if !strings.HasSuffix(f, ".local/state/o/panes/01a1d24d-dbd4-7274-99c2-c50db953ded1.json") {
		t.Fatal(f)
	}
	if filepath.Base(File("block:../x")) != "x.json" {
		t.Fatal(File("block:../x"))
	}
}

func TestWritesReadsAndRemoves(t *testing.T) {
	f := filepath.Join(t.TempDir(), "b.json")
	imgs := []drafts.Tagged{{N: 1, Path: "/a.png"}, {N: 3, Path: "/c d.png"}}
	writeTo(f, Sent, imgs)
	kind, got, ok := Read(f)
	if !ok || kind != Sent || !reflect.DeepEqual(got, imgs) {
		t.Fatal(kind, got)
	}
	raw, _ := os.ReadFile(f)
	if string(raw) != `{"images":[{"n":1,"path":"/a.png"},{"n":3,"path":"/c d.png"}],"kind":"sent"}` {
		t.Fatal(string(raw))
	}
	writeTo(f, Prompt, nil)
	if _, err := os.Stat(f); err == nil {
		t.Fatal("still there")
	}
}
