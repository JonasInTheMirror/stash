//go:build unix && !darwin

package generate

import (
	"os/exec"
	"syscall"
)

// setBackgroundPriority lowers the CPU priority of a generation process so
// that it does not starve interactive work such as video streaming.
func setBackgroundPriority(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 19)
}
