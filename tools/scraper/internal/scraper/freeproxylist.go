package scraper

import (
	"bytes"
	"context"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/tensanq/proxy-scraper/internal/model"
)

// FreeProxyList scrapes https://free-proxy-list.net
type FreeProxyList struct{}

func (f *FreeProxyList) Name() string { return "free-proxy-list.net" }

func (f *FreeProxyList) Scrape(ctx context.Context) ([]model.Proxy, error) {
	body, err := httpGet(ctx, "https://free-proxy-list.net/")
	if err != nil {
		return nil, err
	}
	return parseFreeProxyTable(body, f.Name())
}

// SSLProxies scrapes https://www.sslproxies.org (same table format).
type SSLProxies struct{}

func (s *SSLProxies) Name() string { return "sslproxies.org" }

func (s *SSLProxies) Scrape(ctx context.Context) ([]model.Proxy, error) {
	body, err := httpGet(ctx, "https://www.sslproxies.org/")
	if err != nil {
		return nil, err
	}
	return parseFreeProxyTable(body, s.Name())
}

func parseFreeProxyTable(body []byte, source string) ([]model.Proxy, error) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	var out []model.Proxy
	doc.Find("table tbody tr").Each(func(_ int, tr *goquery.Selection) {
		tds := tr.Find("td")
		if tds.Length() < 7 {
			return
		}
		ip := strings.TrimSpace(tds.Eq(0).Text())
		portStr := strings.TrimSpace(tds.Eq(1).Text())
		code := strings.TrimSpace(tds.Eq(2).Text())
		country := strings.TrimSpace(tds.Eq(3).Text())
		anon := strings.TrimSpace(tds.Eq(4).Text())
		https := strings.TrimSpace(tds.Eq(6).Text())

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return
		}
		ptype := model.HTTP
		if strings.EqualFold(https, "yes") {
			ptype = model.HTTPS
		}
		out = append(out, model.Proxy{
			IP:          ip,
			Port:        port,
			Type:        ptype,
			Country:     country,
			CountryCode: code,
			Anonymous:   strings.Contains(strings.ToLower(anon), "anonymous") || strings.Contains(strings.ToLower(anon), "elite"),
			Source:      source,
		})
	})
	return out, nil
}
