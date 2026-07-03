//go:build windows

package generate

import "os/exec"

// setBackgroundPriority is a no-op on Windows.
func setBackgroundPriority(cmd *exec.Cmd) {}
