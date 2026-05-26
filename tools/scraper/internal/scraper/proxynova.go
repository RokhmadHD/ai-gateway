package scraper

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/tensanq/proxy-scraper/internal/model"
)

// ProxyNova obfuscates IPs with JS like:
//   document.write('123.45.'.substr(0) + '67.89');
// We extract the substr-ed segments and reassemble.
type ProxyNova struct{}

func (p *ProxyNova) Name() string { return "proxynova.com" }

var (
	substrRe   = regexp.MustCompile(`'([^']*)'\.substr\((\d+)\)`)
	plainStrRe = regexp.MustCompile(`'([^']+)'`)
)

func (p *ProxyNova) Scrape(ctx context.Context) ([]model.Proxy, error) {
	// Country pages give richer results; we use the global list.
	urls := []string{
		"https://www.proxynova.com/proxy-server-list/",
		"https://www.proxynova.com/proxy-server-list/elite-proxies/",
	}

	var out []model.Proxy
	seen := map[string]bool{}

	for _, u := range urls {
		body, err := httpGet(ctx, u)
		if err != nil {
			return out, err
		}
		doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
		if err != nil {
			continue
		}
		doc.Find("table#tbl_proxy_list tbody tr").Each(func(_ int, tr *goquery.Selection) {
			tds := tr.Find("td")
			if tds.Length() < 6 {
				return
			}
			ip := decodeProxyNovaIP(tds.Eq(0).Text())
			portStr := strings.TrimSpace(tds.Eq(1).Text())
			country := strings.TrimSpace(tds.Eq(5).Find("a").Text())
			if ip == "" {
				return
			}
			port, err := strconv.Atoi(portStr)
			if err != nil {
				return
			}
			key := fmt.Sprintf("%s:%d", ip, port)
			if seen[key] {
				return
			}
			seen[key] = true
			out = append(out, model.Proxy{
				IP:      ip,
				Port:    port,
				Type:    model.HTTP,
				Country: country,
				Source:  "proxynova.com",
			})
		})
	}
	return out, nil
}

// decodeProxyNovaIP reconstructs the IP from the JS in the table cell.
// Falls back to a plain regex match if no substr() pattern is present.
func decodeProxyNovaIP(raw string) string {
	// Try substr() reassembly.
	matches := substrRe.FindAllStringSubmatch(raw, -1)
	if len(matches) >= 2 {
		var b strings.Builder
		for _, m := range matches {
			n, _ := strconv.Atoi(m[2])
			s := m[1]
			if n < 0 || n > len(s) {
				continue
			}
			b.WriteString(s[n:])
		}
		ip := strings.TrimSpace(b.String())
		if isIPv4(ip) {
			return ip
		}
	}
	// Try concatenating all quoted literals.
	parts := plainStrRe.FindAllStringSubmatch(raw, -1)
	if len(parts) > 0 {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p[1])
		}
		ip := strings.TrimSpace(b.String())
		if isIPv4(ip) {
			return ip
		}
	}
	// Last resort: regex on raw.
	if m := ipPortRe.FindStringSubmatch(raw); len(m) > 0 {
		return m[1]
	}
	return ""
}

func isIPv4(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return false
	}
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return false
		}
	}
	return true
}
