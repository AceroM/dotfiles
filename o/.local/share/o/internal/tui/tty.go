package tui

import (
	"os"
	"os/signal"
	"syscall"
	"time"
	"unsafe"
)

// Tty is the terminal: /dev/tty (else stdin) for keys and raw mode, stdout
// for what's drawn.
type Tty struct {
	In    *os.File
	saved *syscall.Termios
}

// OpenTty opens the controlling terminal for reading. It isn't in raw mode yet.
func OpenTty() (*Tty, error) {
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		if !IsTerminal(os.Stdin) {
			return nil, err
		}
		f = os.Stdin
	}
	return &Tty{In: f}, nil
}

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool {
	var t syscall.Termios
	return ioctl(f.Fd(), ioctlGetTermios, unsafe.Pointer(&t)) == nil
}

// Raw puts the terminal in raw mode, as cfmakeraw does: keys one at a time,
// unechoed, no signals from ^c or ^z, output untranslated.
func (t *Tty) Raw() error {
	var cur syscall.Termios
	if err := ioctl(t.In.Fd(), ioctlGetTermios, unsafe.Pointer(&cur)); err != nil {
		return err
	}
	saved := cur
	cur.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP | syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	cur.Oflag &^= syscall.OPOST
	cur.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	cur.Cflag &^= syscall.CSIZE | syscall.PARENB
	cur.Cflag |= syscall.CS8
	cur.Cc[syscall.VMIN] = 1
	cur.Cc[syscall.VTIME] = 0
	if err := ioctl(t.In.Fd(), ioctlSetTermios, unsafe.Pointer(&cur)); err != nil {
		return err
	}
	t.saved = &saved
	return nil
}

// Restore puts the terminal back as Raw found it.
func (t *Tty) Restore() {
	if t.saved != nil {
		_ = ioctl(t.In.Fd(), ioctlSetTermios, unsafe.Pointer(t.saved))
		t.saved = nil
	}
}

type winsize struct{ Row, Col, Xpixel, Ypixel uint16 }

// Size is the terminal's columns and rows, and its size in pixels (0 where
// it doesn't say).
func Size() (cols, rows, w, h int, err error) {
	var ws winsize
	for _, f := range []*os.File{os.Stdout, os.Stdin, os.Stderr} {
		if err = ioctl(f.Fd(), syscall.TIOCGWINSZ, unsafe.Pointer(&ws)); err == nil {
			return int(ws.Col), int(ws.Row), int(ws.Xpixel), int(ws.Ypixel), nil
		}
	}
	tty, e := os.Open("/dev/tty")
	if e != nil {
		return 0, 0, 0, 0, err
	}
	defer tty.Close()
	if err = ioctl(tty.Fd(), syscall.TIOCGWINSZ, unsafe.Pointer(&ws)); err != nil {
		return 0, 0, 0, 0, err
	}
	return int(ws.Col), int(ws.Row), int(ws.Xpixel), int(ws.Ypixel), nil
}

func ioctl(fd uintptr, req uintptr, arg unsafe.Pointer) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(arg)); e != 0 {
		return e
	}
	return nil
}

// Input reads the terminal's bytes on a goroutine of its own and decodes
// them into events as they're asked for.
type Input struct {
	tty    *Tty
	chunks chan []byte
	winch  chan os.Signal
	buf    []byte
	queue  []Event
	// When the bytes in buf last grew: an ESC alone this long is the key.
	got time.Time
}

// escWait is how long a lone ESC waits for the rest of a sequence before it
// counts as the Esc key. A terminal writes a sequence whole, so a short wait.
const escWait = 25 * time.Millisecond

func NewInput(t *Tty) *Input {
	in := &Input{tty: t, chunks: make(chan []byte, 64), winch: make(chan os.Signal, 1)}
	signal.Notify(in.winch, syscall.SIGWINCH)
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := t.In.Read(b)
			if n > 0 {
				in.chunks <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				close(in.chunks)
				return
			}
		}
	}()
	return in
}

// Raw collects the terminal's bytes, undecoded, until done says they're
// all there or timeout passes (probe.go's replies). They stay unread for
// Next too.
func (in *Input) Raw(timeout time.Duration, done func([]byte) bool) []byte {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for !done(in.buf) {
		select {
		case c, ok := <-in.chunks:
			if !ok {
				return in.buf
			}
			in.add(c)
		case <-deadline.C:
			return in.buf
		}
	}
	return in.buf
}

// Drop takes the first n bytes Raw collected out of the input.
func (in *Input) Drop(n int) { in.buf = in.buf[min(n, len(in.buf)):] }

// Next is the next event, waiting at most timeout for one (0: only what's
// already here). False when there's none yet.
func (in *Input) Next(timeout time.Duration) (Event, bool) {
	var deadline <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		deadline = t.C
	}
	for {
		if len(in.queue) > 0 {
			ev := in.queue[0]
			in.queue = in.queue[1:]
			return ev, true
		}
		ev, took, wait := in.decodeOne()
		if took {
			if ev != nil {
				return ev, true
			}
			continue
		}
		if wait > 0 {
			if timeout <= 0 {
				return nil, false
			}
			// An ESC alone, so far: its key unless more comes soon.
			t := time.NewTimer(wait)
			select {
			case c, ok := <-in.chunks:
				if ok {
					in.add(c)
				}
			case <-t.C:
			case <-in.winch:
				in.queue = append(in.queue, in.resize())
			case <-deadline:
				t.Stop()
				return nil, false
			}
			t.Stop()
			continue
		}
		if timeout <= 0 {
			select {
			case c, ok := <-in.chunks:
				if !ok {
					return nil, false
				}
				in.add(c)
				continue
			case <-in.winch:
				return in.resize(), true
			default:
				return nil, false
			}
		}
		select {
		case c, ok := <-in.chunks:
			if !ok {
				return nil, false
			}
			in.add(c)
		case <-in.winch:
			return in.resize(), true
		case <-deadline:
			return nil, false
		}
	}
}

func (in *Input) add(c []byte) {
	in.buf = append(in.buf, c...)
	in.got = time.Now()
}

// decodeOne takes one event off buf: ok when it took bytes (the event may
// be nil); else how long to wait before an incomplete ESC … counts as keys.
func (in *Input) decodeOne() (ev Event, ok bool, wait time.Duration) {
	if len(in.buf) == 0 {
		return nil, false, 0
	}
	ev, n, incomplete := decode(in.buf)
	if !incomplete {
		in.buf = in.buf[n:]
		return ev, true, 0
	}
	if in.buf[0] != 0x1b || bytes0(in.buf, pasteStart) {
		// A paste or a character still arriving: wait for the rest.
		return nil, false, 0
	}
	if left := escWait - time.Since(in.got); left > 0 {
		return nil, false, left
	}
	// Nothing more came: the ESC is the key, and what follows is read anew.
	in.buf = in.buf[1:]
	return Key{Code: KeyEsc}, true, 0
}

func bytes0(b, prefix []byte) bool {
	if len(b) < len(prefix) {
		return string(prefix[:len(b)]) == string(b)
	}
	return string(b[:len(prefix)]) == string(prefix)
}

func (in *Input) resize() Event {
	w, h, _, _, err := Size()
	if err != nil {
		w, h = 80, 24
	}
	return Resize{W: w, H: h}
}

// CursorPosition asks the terminal where the cursor is, holding the events
// that come before the answer for Next. False when it doesn't answer.
func (in *Input) CursorPosition(timeout time.Duration) (x, y int, ok bool) {
	if _, err := os.Stdout.WriteString("\x1b[6n"); err != nil {
		return 0, 0, false
	}
	held := in.queue
	in.queue = nil
	defer func() { in.queue = append(held, in.queue...) }()
	end := time.Now().Add(timeout)
	for {
		left := time.Until(end)
		if left <= 0 {
			return 0, 0, false
		}
		ev, got := in.Next(left)
		if !got {
			return 0, 0, false
		}
		if p, isPos := ev.(CursorPos); isPos {
			return p.X, p.Y, true
		}
		held = append(held, ev)
	}
}
