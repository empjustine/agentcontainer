package main

import (
	"fmt"
	"strings"
)

// buildCPIO writes the newc (SVR4, "070701") archive RPM uses as payload. RPM
// stores paths relative to the install root with a leading "./"; directories
// are real entries so the archive can be extracted on its own.
func buildCPIO(files []pkgFile, mtime int64) []byte {
	var out strings.Builder
	for i, f := range files {
		name := "./" + strings.TrimPrefix(f.path, "/")
		nlink := 1
		if f.dir {
			nlink = 2
		}
		writeNewcEntry(&out, name, f.mode, uint32(len(f.data)), mtime, uint32(i+1), nlink, f.data)
	}
	writeNewcEntry(&out, "TRAILER!!!", 0, 0, mtime, 0, 1, nil)
	return []byte(out.String())
}

func writeNewcEntry(out *strings.Builder, name string, mode int64, size uint32, mtime int64, ino uint32, nlink int, data []byte) {
	// 070701 + thirteen 8-byte hex fields. devmajor/devminor/rdevmajor/
	// rdevminor/check are zero: no device nodes and no CRC in newc.
	fmt.Fprintf(out, "070701%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x",
		ino,
		uint32(mode),
		0, // uid: every packaged path is root-owned
		0, // gid
		nlink,
		mtime,
		size,
		0, // devmajor
		0, // devminor
		0, // rdevmajor
		0, // rdevminor
		uint32(len(name)+1),
		0, // check
	)
	out.WriteString(name)
	out.WriteByte(0)
	pad4(out, 110+len(name)+1)
	out.Write(data)
	pad4(out, len(data))
}

func pad4(out *strings.Builder, n int) {
	for n%4 != 0 {
		out.WriteByte(0)
		n++
	}
}
