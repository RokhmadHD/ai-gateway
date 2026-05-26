package checker

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"
)

// dialSocks4 performs a minimal SOCKS4 CONNECT to `proxyAddr` then asks it to
// reach `targetAddr`. It does *not* support SOCKS4a domain resolution — we
// always resolve hostnames locally first.
func dialSocks4(ctx context.Context, proxyAddr, targetAddr string, timeout time.Duration) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(targetAddr)
	if err != nil {
		return nil, fmt.Errorf("socks4: parse target: %w", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, err
	}

	var ip net.IP
	if parsed := net.ParseIP(host); parsed != nil {
		ip = parsed.To4()
	} else {
		ips, err := (&net.Resolver{}).LookupIP(ctx, "ip4", host)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("socks4: resolve %s: %w", host, err)
		}
		ip = ips[0].To4()
	}
	if ip == nil {
		return nil, errors.New("socks4: target is not IPv4")
	}

	d := &net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(timeout))
	}

	// SOCKS4 CONNECT request: VER(1)=4 CMD(1)=1 PORT(2) IP(4) USERID(var) NULL.
	buf := make([]byte, 0, 9)
	buf = append(buf, 0x04, 0x01)
	pb := make([]byte, 2)
	binary.BigEndian.PutUint16(pb, uint16(port))
	buf = append(buf, pb...)
	buf = append(buf, ip...)
	buf = append(buf, 0x00) // empty user id + null terminator
	if _, err := conn.Write(buf); err != nil {
		conn.Close()
		return nil, err
	}

	resp := make([]byte, 8)
	if _, err := readFull(conn, resp); err != nil {
		conn.Close()
		return nil, err
	}
	if resp[0] != 0x00 || resp[1] != 0x5A {
		conn.Close()
		return nil, fmt.Errorf("socks4: request rejected (code=0x%02x)", resp[1])
	}

	// Clear the deadline; the http.Client manages overall timeout.
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func readFull(conn net.Conn, b []byte) (int, error) {
	total := 0
	for total < len(b) {
		n, err := conn.Read(b[total:])
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}
