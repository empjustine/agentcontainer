package main

import (
	"fmt"
	"io"
	"time"
)

// arMember is one member of the System V/GNU ar archive a .deb starts with.
type arMember struct {
	name    string
	data    []byte
	mode    int64
	modTime time.Time
}

// writeAr writes the common GNU ar shape dpkg reads: a global magic line, then
// a 60-byte ASCII header per member, followed by the data padded to an even
// offset with '\n'. Member names stay under 15 bytes (the fixed 16-byte field
// with GNU's trailing slash); none of the three .deb members needs a long-name
// table.
func writeAr(w io.Writer, members []arMember) error {
	if _, err := io.WriteString(w, "!<arch>\n"); err != nil {
		return err
	}
	for _, m := range members {
		name := m.name + "/"
		if len(name) > 16 {
			return fmt.Errorf("ar member name %q longer than 15 bytes", m.name)
		}
		header := fmt.Sprintf("%-16s%-12d%-6d%-6d%-8o%-10d`\n",
			name, m.modTime.Unix(), 0, 0, m.mode, len(m.data))
		if len(header) != 60 {
			return fmt.Errorf("ar header for %q is %d bytes, want 60", m.name, len(header))
		}
		if _, err := io.WriteString(w, header); err != nil {
			return err
		}
		if _, err := w.Write(m.data); err != nil {
			return err
		}
		if len(m.data)%2 != 0 {
			if _, err := io.WriteString(w, "\n"); err != nil {
				return err
			}
		}
	}
	return nil
}
