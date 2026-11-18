package reply

import (
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"unicode"

	"o/internal/field"
	"o/internal/term"
	"o/internal/tui"
)

func compose(to target) error {
	tty, err := tui.OpenTty()
	if err != nil {
		return err
	}
	if tty.In != os.Stdin {
		defer tty.In.Close()
	}
	if err := tty.Raw(); err != nil {
		return err
	}
	defer tty.Restore()

	defer os.Stdout.WriteString("\x1b[<1u\x1b[?2004l\x1b[0m\x1b[?25h")
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGHUP, syscall.SIGTERM)
	defer signal.Stop(stop)

	w, h, _, _, err := tui.Size()
	if err != nil || w < 1 || h < 1 {
		w, h = defaultColumns, 6
	}
	in := tui.NewInput(tty)
	screen := term.New(w, h, 0, 0)
	input := field.New("")
	status := ""
	pasted := false
	output := []byte("\x1b[H\x1b[2J\x1b[?2004h\x1b[>1u")
	for {
		frame, cursor := draw(&input, w, h, status)
		screen.Draw(&output, frame, cursor)
		if _, err := os.Stdout.Write(output); err != nil {
			return err
		}
		output = output[:0]
		var ev tui.Event
		for {
			select {
			case <-stop:
				return nil
			default:
			}
			var ok bool
			if ev, ok = in.Next(250 * time.Millisecond); ok {
				break
			}
		}
		switch e := ev.(type) {
		case tui.Resize:
			w, h = max(e.W, 1), max(e.H, 1)
			os.Stdout.WriteString("\x1b[0m\x1b[H\x1b[2J")
			screen = term.New(w, h, 0, 0)
		case tui.Paste:
			if !pasted {
				input.Insert(cleanPaste(string(e)))
				status = ""
			}
		case tui.Key:
			if e.Release {
				continue
			}
			ctrl := e.Has(tui.ModCtrl)
			if e.Code == tui.KeyEsc || (ctrl && e.Is('c')) {
				return nil
			}
			switch {
			case e.Code == tui.KeyEnter && !e.Has(tui.ModShift|tui.ModAlt):
				if strings.TrimSpace(input.Text) == "" {
					continue
				}
				result, err := to.submit(input.Text, pasted)
				if err != nil {
					status = err.Error()
					continue
				}
				pasted = pasted || result.Pasted
				if result.Error != "" {
					status = result.Error
					continue
				}
				return nil
			case pasted:
				continue // The text already belongs to the agent's input field.
			case e.Code == tui.KeyEnter || (ctrl && e.Is('j')):
				input.Insert("\n")
			case (e.Code == tui.KeyUp || e.Code == tui.KeyDown) && !e.Has(tui.ModAlt|tui.ModSuper):
				direction := -1
				if e.Code == tui.KeyDown {
					direction = 1
				}
				input.VerticalBy(field.WordRows(input.Text, textWidth(w)), direction, e.Has(tui.ModShift))
			default:
				input.Key(e)
			}
			status = ""
		}
	}
}

const (
	defaultColumns = 38
	maxColumns     = 48
	gutter         = 2 // "↳ "
)

func textWidth(w int) int { return max(min(w, maxColumns)-gutter-2, 1) }

func draw(input *field.Field, w, h int, status string) (*tui.Buffer, *[2]int) {
	width := max(min(w, maxColumns)-1, 1)
	rows := field.WordRows(input.Text, textWidth(w))
	row := 0
	for row+1 < len(rows) && rows[row+1].Start <= input.Cur {
		row++
	}
	room := h
	if status != "" && h > 1 {
		room--
	}
	first := max(0, row-room+1)
	visible := rows[first:min(first+room, len(rows))]
	frameHeight := len(visible)
	if status != "" {
		frameHeight = min(frameHeight+1, h)
	}
	frame := tui.NewBuffer(tui.Rect{W: width, H: frameHeight})
	if status != "" {
		frame.SetString(0, frame.Area.H-1, status, tui.FgStyle(tui.Red))
		if h == 1 {
			return frame, nil
		}
	}
	frame.SetString(0, 0, "↳", tui.NewStyle().Add(tui.Dim))
	selection := input.Selection()
	for y, r := range visible {
		text := input.Text[r.Start:r.End]
		frame.SetString(gutter, y, text, tui.NewStyle())
		if input.HasSelection() {
			x := gutter
			for i, char := range text {
				if cell := frame.Cell(x, y); cell != nil && selection.Contains(r.Start+i) {
					cell.Mod |= tui.Reversed
				}
				x += tui.RuneWidth(char)
			}
		}
	}
	x := gutter + field.StrWidth(input.Text[rows[row].Start:input.Cur])
	return frame, &[2]int{min(x, width-1), row - first}
}

func cleanPaste(text string) string {
	text = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\t", "    ").Replace(text)
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' {
			return -1
		}
		return r
	}, text)
}
