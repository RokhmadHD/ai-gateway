package model

import (
	"fmt"
	"time"
)

type ProxyType string

const (
	HTTP    ProxyType = "http"
	HTTPS   ProxyType = "https"
	SOCKS4  ProxyType = "socks4"
	SOCKS5  ProxyType = "socks5"
	Unknown ProxyType = "unknown"
)

type Proxy struct {
	IP          string        `json:"ip"`
	Port        int           `json:"port"`
	Type        ProxyType     `json:"type"`
	Country     string        `json:"country,omitempty"`
	CountryCode string        `json:"country_code,omitempty"`
	City        string        `json:"city,omitempty"`
	ISP         string        `json:"isp,omitempty"`
	Latency     time.Duration `json:"latency_ms,omitempty"`
	Alive       bool          `json:"alive"`
	Source      string        `json:"source"`
	Anonymous   bool          `json:"anonymous,omitempty"`
	CheckedAt   time.Time     `json:"checked_at,omitempty"`
}

func (p Proxy) Addr() string {
	return fmt.Sprintf("%s:%d", p.IP, p.Port)
}

func (p Proxy) URL() string {
	scheme := string(p.Type)
	if p.Type == Unknown {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s", scheme, p.Addr())
}

func (p Proxy) Key() string {
	return fmt.Sprintf("%s://%s:%d", p.Type, p.IP, p.Port)
}
