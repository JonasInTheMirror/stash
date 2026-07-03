//go:build darwin

package generate

import (
	"os/exec"
	"strconv"
	"syscall"
)

// setBackgroundPriority lowers the CPU priority of a generation process so
// that it does not starve interactive work such as video streaming. On
// macOS it additionally applies the background task policy, which also
// throttles disk I/O - important when the library lives on a slow external
// drive that playback streams from.
func setBackgroundPriority(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, pid, 19)

	// best effort: background I/O policy via taskpolicy
	_ = exec.Command("/usr/sbin/taskpolicy", "-b", "-p", strconv.Itoa(pid)).Run()
}
