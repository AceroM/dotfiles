package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The renderer consumes the patch on stdout. On success stderr carries an
// optional status-bar note. On failure it carries the error instead.
func serveSource(args []string) int {
	var data []byte
	var note string
	var err error
	switch {
	case args[0] == "--jv-meta":
		data, err = prView(args[1:], "number,title,author,headRefName,baseRefName,isDraft,state,url",
			"[.number, .title, .author.login, .headRefName, .baseRefName, .isDraft, .state, .url] | @tsv")
	case len(args) > 1:
		data, note, err = fetch(args[1], args[2:])
	default:
		err = errors.New("missing diff source")
	}
	if err == nil {
		_, err = os.Stdout.Write(data)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if note != "" {
		fmt.Fprintln(os.Stderr, note)
	}
	return 0
}

func fetch(source string, args []string) ([]byte, string, error) {
	var data []byte
	var err error
	switch source {
	case "pr":
		return prDiff(args)
	case "git":
		data, err = gitDiff(args...)
	case "local":
		data, err = gitDiff("HEAD")
	case "cmd":
		if len(args) != 1 {
			return nil, "", errors.New("expected one shell command")
		}
		data, err = output("sh", "-c", args[0])
	default:
		return nil, "", fmt.Errorf("unknown diff source %q", source)
	}
	return data, "", err
}

func gitDiff(args ...string) ([]byte, error) {
	base := []string{"-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff"}
	return output("git", append(base, args...)...)
}

func prDiff(args []string) ([]byte, string, error) {
	diffArgs := append([]string{"pr", "diff"}, args...)
	data, err := output("gh", append(diffArgs, "--color=never")...)
	if err == nil {
		return data, "", nil
	}
	if !strings.Contains(err.Error(), "too_large") && !strings.Contains(err.Error(), "exceeded the maximum number of lines") {
		return nil, "", err
	}
	data, localErr := localPRDiff(args)
	if localErr != nil {
		return nil, "", fmt.Errorf("%w\nbuilding it locally failed too: %v", err, localErr)
	}
	return data, "too big for GitHub's diff API · built locally (git diff base...head)", nil
}

// GitHub's PR diff compares the pushed base and head. A local branch of the
// same name may have moved or belong to a different author.
func localPRDiff(args []string) ([]byte, error) {
	info, err := prView(args, "number,baseRefName,baseRefOid,headRefOid",
		"[.number, .baseRefName, .baseRefOid, .headRefOid] | @tsv")
	if err != nil {
		return nil, err
	}
	fields := strings.Split(strings.TrimSpace(string(info)), "\t")
	if len(fields) != 4 {
		return nil, fmt.Errorf("unexpected `gh pr view` output: %s", bytes.TrimSpace(info))
	}
	number, branch, base, head := fields[0], fields[1], fields[2], fields[3]
	haveCommit := func(oid string) bool {
		return exec.Command("git", "cat-file", "-e", oid+"^{commit}").Run() == nil
	}
	if !haveCommit(base) || !haveCommit(head) {
		if _, err := output("git", "fetch", "--quiet", "--no-tags", "origin", branch, "refs/pull/"+number+"/head"); err != nil {
			return nil, err
		}
	}
	return gitDiff(base + "..." + head)
}

// Only a PR selector and the repository override apply to both diff and view.
func prView(args []string, fields, query string) ([]byte, error) {
	cmd := []string{"pr", "view"}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-R" || arg == "--repo":
			cmd = append(cmd, arg)
			if i+1 < len(args) {
				i++
				cmd = append(cmd, args[i])
			}
		case strings.HasPrefix(arg, "--repo=") || !strings.HasPrefix(arg, "-"):
			cmd = append(cmd, arg)
		}
	}
	return output("gh", append(cmd, "--json", fields, "--jq", query)...)
}

func output(program string, args ...string) ([]byte, error) {
	var stderr bytes.Buffer
	cmd := exec.Command(program, args...)
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err == nil {
		return data, nil
	}
	if msg := strings.TrimSpace(stderr.String()); msg != "" {
		return nil, errors.New(msg)
	}
	var status *exec.ExitError
	if errors.As(err, &status) && status.ExitCode() >= 0 {
		return nil, fmt.Errorf("%s exited with exit status: %d", program, status.ExitCode())
	}
	return nil, fmt.Errorf("%s: %w", program, err)
}
