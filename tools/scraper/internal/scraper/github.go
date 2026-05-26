package scraper

import (
	"context"

	"github.com/tensanq/proxy-scraper/internal/model"
)

// GitHub raw proxy lists. Highly reliable, frequently updated.
type githubList struct {
	url    string
	ptype  model.ProxyType
	source string
}

func (g *githubList) Name() string { return g.source }

func (g *githubList) Scrape(ctx context.Context) ([]model.Proxy, error) {
	body, err := httpGet(ctx, g.url)
	if err != nil {
		return nil, err
	}
	return parseIPPortLines(body, g.ptype, g.source), nil
}

// NewGitHubScrapers returns scrapers for popular GitHub-hosted proxy lists.
func NewGitHubScrapers(want func(model.ProxyType) bool) []Scraper {
	const speedx = "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master"
	const monosans = "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies"
	const proxifly = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies"

	all := []*githubList{
		{speedx + "/http.txt", model.HTTP, "TheSpeedX/http"},
		{speedx + "/socks4.txt", model.SOCKS4, "TheSpeedX/socks4"},
		{speedx + "/socks5.txt", model.SOCKS5, "TheSpeedX/socks5"},
		{monosans + "/http.txt", model.HTTP, "monosans/http"},
		{monosans + "/socks4.txt", model.SOCKS4, "monosans/socks4"},
		{monosans + "/socks5.txt", model.SOCKS5, "monosans/socks5"},
		{proxifly + "/protocols/http/data.txt", model.HTTP, "proxifly/http"},
		{proxifly + "/protocols/socks4/data.txt", model.SOCKS4, "proxifly/socks4"},
		{proxifly + "/protocols/socks5/data.txt", model.SOCKS5, "proxifly/socks5"},
	}

	var out []Scraper
	for _, s := range all {
		if !want(s.ptype) {
			continue
		}
		out = append(out, s)
	}
	return out
}
