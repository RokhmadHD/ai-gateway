package scraper

import (
	"context"
	"fmt"

	"github.com/tensanq/proxy-scraper/internal/model"
)

// ProxyScrape API — free, no key required.
type proxyScrape struct {
	protocol string
	ptype    model.ProxyType
}

func (p *proxyScrape) Name() string { return "proxyscrape/" + p.protocol }

func (p *proxyScrape) Scrape(ctx context.Context) ([]model.Proxy, error) {
	url := fmt.Sprintf(
		"https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=%s&proxy_format=ipport&format=text&timeout=10000",
		p.protocol,
	)
	body, err := httpGet(ctx, url)
	if err != nil {
		return nil, err
	}
	return parseIPPortLines(body, p.ptype, p.Name()), nil
}

func NewProxyScrapeScrapers(want func(model.ProxyType) bool) []Scraper {
	specs := []proxyScrape{
		{"http", model.HTTP},
		{"socks4", model.SOCKS4},
		{"socks5", model.SOCKS5},
	}
	var out []Scraper
	for i := range specs {
		if !want(specs[i].ptype) {
			continue
		}
		s := specs[i]
		out = append(out, &s)
	}
	return out
}
