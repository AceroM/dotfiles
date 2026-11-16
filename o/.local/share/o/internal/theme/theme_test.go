package theme

import "testing"

func TestReadsRexsTheme(t *testing.T) {
	th, err := rex("")
	if err != nil {
		t.Skip("no Rex here:", err)
	}
	if !th.Rex || th.Panel != 0 {
		t.Fatalf("%+v", th)
	}
	t.Log(th.Name, th.Accent)
}

func TestCSS(t *testing.T) {
	vars := map[string]any{"a": "13 17 23", "b": "rgb(52 133 250 / 0.5)", "c": "#e6edf3"}
	bg := RGB{0, 0, 0}
	if c, _ := css(vars, "a", nil); c != (RGB{13, 17, 23}) {
		t.Error(c)
	}
	if c, _ := css(vars, "b", &bg); c != (RGB{26, 67, 125}) {
		t.Error(c)
	}
	if c, _ := css(vars, "c", nil); c != (RGB{0xe6, 0xed, 0xf3}) {
		t.Error(c)
	}
}
