package main

import (
	"bytes"
	"compress/gzip"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"
)

// RPM header tag numbers used here (rpm/rpmtag.h). The writer emits a v3
// package: lead, a signature header with the SIZE/SHA1/SHA256/MD5/
// PAYLOADSIZE tags and their region, the immutable main header, then the
// gzip-compressed cpio payload. Cryptographic signatures are deliberately out
// of scope (unsigned), but the signature header still has to be present and
// well-formed: rpm refuses a package whose signature header has no tags.
const (
	rpmTagName              = 1000
	rpmTagVersion           = 1001
	rpmTagRelease           = 1002
	rpmTagSummary           = 1004
	rpmTagDescription       = 1005
	rpmTagBuildTime         = 1006
	rpmTagBuildHost         = 1007
	rpmTagSize              = 1009
	rpmTagDistribution      = 1010
	rpmTagVendor            = 1011
	rpmTagLicense           = 1014
	rpmTagPackager          = 1015
	rpmTagGroup             = 1016
	rpmTagURL               = 1020
	rpmTagOS                = 1021
	rpmTagArch              = 1022
	rpmTagPreIn             = 1023
	rpmTagPostIn            = 1024
	rpmTagPreUn             = 1025
	rpmTagPostUn            = 1026
	rpmTagFileSizes         = 1028
	rpmTagFileModes         = 1030
	rpmTagFileRDevs         = 1033
	rpmTagFileMTimes        = 1034
	rpmTagFileDigests       = 1035
	rpmTagFileLinkTos       = 1036
	rpmTagFileFlags         = 1037
	rpmTagFileUserName      = 1039
	rpmTagFileGroupName     = 1040
	rpmTagFileVerifyFlags   = 1045
	rpmTagArchiveSize       = 1046
	rpmTagProvideName       = 1047
	rpmTagRequireFlags      = 1048
	rpmTagRequireName       = 1049
	rpmTagRequireVersion    = 1050
	rpmTagRPMVersion        = 1064
	rpmTagPreInProg         = 1085
	rpmTagPostInProg        = 1086
	rpmTagPreUnProg         = 1087
	rpmTagPostUnProg        = 1088
	rpmTagFileDevices       = 1095
	rpmTagFileInodes        = 1096
	rpmTagFileLangs         = 1097
	rpmTagProvideFlags      = 1112
	rpmTagProvideVersion    = 1113
	rpmTagDirIndexes        = 1116
	rpmTagBaseNames         = 1117
	rpmTagDirNames          = 1118
	rpmTagPayloadFormat     = 1124
	rpmTagPayloadCompressor = 1125
	rpmTagPayloadFlags      = 1126
	rpmTagPlatform          = 1132
	rpmTagFileDigestAlgo    = 5011
	rpmTagPayloadDigest     = 5092
	rpmTagPayloadDigestAlgo = 5093
)

// RPM header value types.
const (
	rpmTypeChar        = 1
	rpmTypeInt16       = 3
	rpmTypeBin         = 7
	rpmTypeInt32       = 4
	rpmTypeString      = 6
	rpmTypeStringArray = 8
	rpmTypeI18NString  = 9
)

type rpmIndexEntry struct {
	tag    uint32
	typ    uint32
	offset uint32
	count  uint32
}

type rpmHeader struct {
	entries []rpmIndexEntry
	data    []byte
}

func (h *rpmHeader) add(tag, typ, count uint32, payload []byte) {
	align := 1
	switch typ {
	case rpmTypeInt16:
		align = 2
	case rpmTypeInt32:
		align = 4
	}
	for len(h.data)%align != 0 {
		h.data = append(h.data, 0)
	}
	h.entries = append(h.entries, rpmIndexEntry{
		tag:    tag,
		typ:    typ,
		offset: uint32(len(h.data)),
		count:  count,
	})
	h.data = append(h.data, payload...)
}

func (h *rpmHeader) addString(tag uint32, value string) {
	h.add(tag, rpmTypeString, 1, append([]byte(value), 0))
}

func (h *rpmHeader) addI18NString(tag uint32, value string) {
	h.add(tag, rpmTypeI18NString, 1, append([]byte(value), 0))
}

func (h *rpmHeader) addStringArray(tag uint32, values []string) {
	var payload []byte
	for _, v := range values {
		payload = append(payload, v...)
		payload = append(payload, 0)
	}
	h.add(tag, rpmTypeStringArray, uint32(len(values)), payload)
}

func (h *rpmHeader) addInt16Array(tag uint32, values []uint16) {
	payload := make([]byte, 2*len(values))
	for i, v := range values {
		binary.BigEndian.PutUint16(payload[i*2:], v)
	}
	h.add(tag, rpmTypeInt16, uint32(len(values)), payload)
}

func (h *rpmHeader) addInt32Array(tag uint32, values []uint32) {
	payload := make([]byte, 4*len(values))
	for i, v := range values {
		binary.BigEndian.PutUint32(payload[i*4:], v)
	}
	h.add(tag, rpmTypeInt32, uint32(len(values)), payload)
}

// bytesRegion renders the header with an RPMTAG_HEADERIMMUTABLE region. Modern
// rpm stores and verifies the header digest over this form; a bare header is
// accepted as a deprecated v3 package but its database entry can fail digest
// checks after rpm merges the legacy signature tags into it.
func (h *rpmHeader) bytesRegion() []byte {
	const regionTag = 63 // RPMTAG_HEADERIMMUTABLE
	entries := len(h.entries) + 1
	offset := len(h.data)
	h.data = append(h.data, regionTrailer(regionTag, entries)...)
	h.entries = append([]rpmIndexEntry{{tag: regionTag, typ: rpmTypeBin, offset: uint32(offset), count: 16}}, h.entries...)
	return h.bytes()
}

func (h *rpmHeader) bytes() []byte {
	var out bytes.Buffer
	out.Write([]byte{0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0})
	var word [4]byte
	binary.BigEndian.PutUint32(word[:], uint32(len(h.entries)))
	out.Write(word[:])
	binary.BigEndian.PutUint32(word[:], uint32(len(h.data)))
	out.Write(word[:])
	for _, e := range h.entries {
		binary.BigEndian.PutUint32(word[:], e.tag)
		out.Write(word[:])
		binary.BigEndian.PutUint32(word[:], e.typ)
		out.Write(word[:])
		binary.BigEndian.PutUint32(word[:], e.offset)
		out.Write(word[:])
		binary.BigEndian.PutUint32(word[:], e.count)
		out.Write(word[:])
	}
	out.Write(h.data)
	return out.Bytes()
}

// rpmFiles is the Oracle Linux payload table: the binary, one unit per role
// (disjoint credentials/listeners, docs/d090), and two conffile env templates.
func rpmFiles(binary []byte) []pkgFile {
	return []pkgFile{
		{path: "/usr", mode: 0o040755, dir: true},
		{path: "/usr/bin", mode: 0o040755, dir: true},
		{path: "/usr/lib", mode: 0o040755, dir: true},
		{path: "/usr/lib/systemd", mode: 0o040755, dir: true},
		{path: "/usr/lib/systemd/system", mode: 0o040755, dir: true},
		{path: "/etc", mode: 0o040755, dir: true},
		{path: "/etc/estige", mode: 0o040755, dir: true},
		{path: "/usr/bin/estige", mode: 0o100755, data: binary},
		{path: "/usr/lib/systemd/system/estige.service", mode: 0o100644, data: embeddedFile("ol/estige.service")},
		{path: "/usr/lib/systemd/system/estige-relay.service", mode: 0o100644, data: embeddedFile("ol/estige-relay.service")},
		{path: "/etc/estige/estige.env", mode: 0o100600, data: embeddedFile("ol/estige.env"), config: true},
		{path: "/etc/estige/estige-relay.env", mode: 0o100600, data: embeddedFile("ol/estige-relay.env"), config: true},
	}
}

func buildRPM(version, release string, binary []byte) ([]byte, error) {
	now := time.Now()
	files := rpmFiles(binary)
	cpio := buildCPIO(files, now.Unix())

	var payload bytes.Buffer
	gz, err := gzip.NewWriterLevel(&payload, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := gz.Write(cpio); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	payloadBytes := payload.Bytes()

	h := &rpmHeader{}
	h.addString(rpmTagName, "estige")
	h.addString(rpmTagVersion, version)
	h.addString(rpmTagRelease, release)
	h.addI18NString(rpmTagSummary, "estige SSL-VPN tunnel node")
	h.addI18NString(rpmTagDescription, "One self-contained Go binary serving the estige exit node or relay node.\nConfiguration is environment only; see the packaged env files.\n")
	h.addInt32Array(rpmTagBuildTime, []uint32{uint32(now.Unix())})
	h.addString(rpmTagBuildHost, hostname())
	h.addInt32Array(rpmTagSize, []uint32{uint32(totalSize(files))})
	h.addString(rpmTagDistribution, "Oracle Linux")
	h.addString(rpmTagVendor, "estige")
	h.addString(rpmTagLicense, "AGPL-3.0-or-later")
	h.addString(rpmTagPackager, "estige maintainers")
	h.addI18NString(rpmTagGroup, "Applications/Internet")
	h.addString(rpmTagOS, "linux")
	h.addString(rpmTagArch, "x86_64")
	h.addString(rpmTagPreIn, string(embeddedFile("ol/prein.sh")))
	h.addString(rpmTagPostIn, string(embeddedFile("ol/postin.sh")))
	h.addString(rpmTagPreUn, string(embeddedFile("ol/preun.sh")))
	h.addString(rpmTagPostUn, string(embeddedFile("ol/postun.sh")))
	h.addInt32Array(rpmTagFileSizes, fileSizes(files))
	h.addInt16Array(rpmTagFileModes, fileModes(files))
	h.addInt16Array(rpmTagFileRDevs, make([]uint16, len(files)))
	h.addInt32Array(rpmTagFileMTimes, repeatInt32(uint32(now.Unix()), len(files)))
	h.addStringArray(rpmTagFileDigests, fileDigests(files))
	h.addStringArray(rpmTagFileLinkTos, make([]string, len(files)))
	h.addInt32Array(rpmTagFileFlags, fileFlags(files))
	h.addStringArray(rpmTagFileUserName, repeatString("root", len(files)))
	h.addStringArray(rpmTagFileGroupName, repeatString("root", len(files)))
	h.addInt32Array(rpmTagFileVerifyFlags, repeatInt32(0xffffffff, len(files)))
	h.addStringArray(rpmTagProvideName, []string{"estige"})
	// rpmlib() entries need RPMSENSE_RPMLIB (1<<24) plus the version sense;
	// without that bit rpm treats them as ordinary package names and cannot
	// satisfy them. PayloadFilesHavePrefix is required because the cpio names
	// start with "./".
	h.addInt32Array(rpmTagRequireFlags, []uint32{0, 16777226, 16777226, 16777226})
	h.addStringArray(rpmTagRequireName, []string{"systemd", "rpmlib(CompressedFileNames)", "rpmlib(FileDigests)", "rpmlib(PayloadFilesHavePrefix)"})
	h.addStringArray(rpmTagRequireVersion, []string{"", "3.0.4-1", "4.6.0-1", "4.0-1"})
	h.addString(rpmTagRPMVersion, "4.16.1.3")
	h.addString(rpmTagPreInProg, "/bin/sh")
	h.addString(rpmTagPostInProg, "/bin/sh")
	h.addString(rpmTagPreUnProg, "/bin/sh")
	h.addString(rpmTagPostUnProg, "/bin/sh")
	h.addInt32Array(rpmTagFileDevices, repeatInt32(1, len(files)))
	h.addInt32Array(rpmTagFileInodes, sequenceInt32(len(files)))
	h.addStringArray(rpmTagFileLangs, make([]string, len(files)))
	h.addInt32Array(rpmTagProvideFlags, []uint32{8})
	h.addStringArray(rpmTagProvideVersion, []string{version + "-" + release})
	dirIndexes, baseNames, dirNames := fileNames(files)
	h.addInt32Array(rpmTagDirIndexes, dirIndexes)
	h.addStringArray(rpmTagBaseNames, baseNames)
	h.addStringArray(rpmTagDirNames, dirNames)
	h.addString(rpmTagPayloadFormat, "cpio")
	h.addString(rpmTagPayloadCompressor, "gzip")
	h.addString(rpmTagPayloadFlags, "9")
	h.addString(rpmTagPlatform, "x86_64-redhat-linux-gnu")
	h.addInt32Array(rpmTagFileDigestAlgo, []uint32{8})
	h.addStringArray(rpmTagPayloadDigest, []string{hex.EncodeToString(sha256Sum(payloadBytes))})
	h.addInt32Array(rpmTagPayloadDigestAlgo, []uint32{8})

	header := h.bytesRegion()
	// RPMSIGTAG_SIZE is the size rpm may read after the signature header:
	// the main header plus the compressed payload. The signature header
	// itself is a region (HEADERSIGNATURES + trailer), so its first index
	// entry is the region tag, not the SIZE tag.
	sigSize := len(header) + len(payloadBytes)
	var out bytes.Buffer
	out.Write(rpmLead(version, release))
	out.Write(pad8(rpmSignatureHeader(sigSize, header, payloadBytes, len(cpio))))
	out.Write(header)
	out.Write(payloadBytes)
	return out.Bytes(), nil
}

// rpmSignatureHeader writes the smallest signature region rpm accepts without
// a signing key: SIZE, header SHA1/SHA256, payload MD5, and the uncompressed
// payload size. A regional header puts the region tag first, its tags after it,
// and a matching trailer at the end of the data; the trailer is not itself an
// index entry. The trailer's offset is negative and counts the index entries
// before it.
func rpmSignatureHeader(size int, header, payload []byte, archiveSize int) []byte {
	const (
		sigTag         = 62 // RPMTAG_HEADERSIGNATURES
		regionType     = rpmTypeBin
		regionEntryCnt = 16
	)
	var h rpmHeader
	h.addString(269, hex.EncodeToString(sha1Sum(header)))   // RPMSIGTAG_SHA1
	h.addString(273, hex.EncodeToString(sha256Sum(header))) // RPMSIGTAG_SHA256
	// MD5 covers the full SIGSIZE span (padded header + payload), not just
	// the compressed payload.
	mac := append(append([]byte{}, header...), payload...)
	h.add(1004, rpmTypeBin, 16, md5Sum(mac))             // RPMSIGTAG_MD5
	h.addInt32Array(1007, []uint32{uint32(archiveSize)}) // RPMSIGTAG_PAYLOADSIZE
	h.addInt32Array(1000, []uint32{uint32(size)})        // RPMSIGTAG_SIZE
	// The region tag has no data of its own; its offset is the trailer's
	// position at the end of the data block.
	h.entries = append([]rpmIndexEntry{{tag: sigTag, typ: regionType, offset: uint32(len(h.data)), count: regionEntryCnt}}, h.entries...)
	h.data = append(h.data, regionTrailer(sigTag, len(h.entries))...)
	return h.bytes()
}

func regionTrailer(tag, entries int) []byte {
	trailer := make([]byte, 16)
	binary.BigEndian.PutUint32(trailer[0:], uint32(tag))
	binary.BigEndian.PutUint32(trailer[4:], rpmTypeBin)
	binary.BigEndian.PutUint32(trailer[8:], uint32(int32(-entries*16)))
	binary.BigEndian.PutUint32(trailer[12:], 16)
	return trailer
}

func sha1Sum(b []byte) []byte   { sum := sha1.Sum(b); return sum[:] }
func sha256Sum(b []byte) []byte { sum := sha256.Sum256(b); return sum[:] }
func md5Sum(b []byte) []byte    { sum := md5.Sum(b); return sum[:] }

func rpmLead(version, release string) []byte {
	lead := make([]byte, 96)
	copy(lead[0:4], []byte{0xed, 0xab, 0xee, 0xdb})
	lead[4] = 3                               // major
	lead[5] = 0                               // minor
	binary.BigEndian.PutUint16(lead[6:8], 0)  // binary package
	binary.BigEndian.PutUint16(lead[8:10], 1) // x86_64
	name := fmt.Sprintf("estige-%s-%s", version, release)
	copy(lead[10:76], name)
	binary.BigEndian.PutUint16(lead[76:78], 1) // Linux
	binary.BigEndian.PutUint16(lead[78:80], 5) // header-style signature
	return lead
}

func pad8(data []byte) []byte {
	if len(data)%8 == 0 {
		return data
	}
	return append(data, make([]byte, 8-len(data)%8)...)
}

func totalSize(files []pkgFile) int64 {
	var total int64
	for _, f := range files {
		total += int64(len(f.data))
	}
	return total
}

func fileSizes(files []pkgFile) []uint32 {
	values := make([]uint32, len(files))
	for i, f := range files {
		values[i] = uint32(len(f.data))
	}
	return values
}

func fileModes(files []pkgFile) []uint16 {
	values := make([]uint16, len(files))
	for i, f := range files {
		values[i] = uint16(f.mode)
	}
	return values
}

func fileFlags(files []pkgFile) []uint32 {
	values := make([]uint32, len(files))
	for i, f := range files {
		if f.config {
			// RPMFILE_CONFIG | RPMFILE_NOREPLACE
			values[i] = 1 | 16
		}
	}
	return values
}

func fileDigests(files []pkgFile) []string {
	values := make([]string, len(files))
	for i, f := range files {
		if f.dir {
			continue
		}
		sum := sha256.Sum256(f.data)
		values[i] = hex.EncodeToString(sum[:])
	}
	return values
}

func fileNames(files []pkgFile) ([]uint32, []string, []string) {
	indexes := make([]uint32, len(files))
	bases := make([]string, len(files))
	var dirs []string
	dirIndex := make(map[string]uint32)
	for i, f := range files {
		cut := strings.LastIndex(f.path, "/") + 1
		dir := f.path[:cut]
		base := f.path[cut:]
		idx, ok := dirIndex[dir]
		if !ok {
			idx = uint32(len(dirs))
			dirIndex[dir] = idx
			dirs = append(dirs, dir)
		}
		indexes[i] = idx
		bases[i] = base
	}
	return indexes, bases, dirs
}

func repeatString(value string, count int) []string {
	values := make([]string, count)
	for i := range values {
		values[i] = value
	}
	return values
}

func repeatInt32(value uint32, count int) []uint32 {
	values := make([]uint32, count)
	for i := range values {
		values[i] = value
	}
	return values
}

func sequenceInt32(count int) []uint32 {
	values := make([]uint32, count)
	for i := range values {
		values[i] = uint32(i + 1)
	}
	return values
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "localhost"
	}
	return name
}
