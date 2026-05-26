package scraper

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/tensanq/proxy-scraper/internal/model"
)

type Scraper interface {
	Name() string
	Scrape(ctx context.Context) ([]model.Proxy, error)
}

var userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "*/*")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

var ipPortRe = regexp.MustCompile(`\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b`)

func parseIPPortLines(body []byte, t model.ProxyType, source string) []model.Proxy {
	var out []model.Proxy
	seen := map[string]bool{}
	for _, m := range ipPortRe.FindAllStringSubmatch(string(body), -1) {
		port, err := strconv.Atoi(m[2])
		if err != nil || port < 1 || port > 65535 {
			continue
		}
		key := m[1] + ":" + m[2]
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, model.Proxy{
			IP:     m[1],
			Port:   port,
			Type:   t,
			Source: source,
		})
	}
	return out
}

// Progress lets callers (e.g. a TUI) observe scraping in real time.
// All hooks are optional and called from background goroutines, so
// implementations must be safe for concurrent use.
type Progress struct {
	OnSourceStart func(name string)
	OnSourceDone  func(name string, count int, err error)
}

// RunAll executes all scrapers concurrently and deduplicates results.
func RunAll(ctx context.Context, scrapers []Scraper, prog Progress) []model.Proxy {
	var mu sync.Mutex
	var wg sync.WaitGroup
	all := map[string]model.Proxy{}

	for _, s := range scrapers {
		wg.Add(1)
		go func(s Scraper) {
			defer wg.Done()
			if prog.OnSourceStart != nil {
				prog.OnSourceStart(s.Name())
			}
			proxies, err := s.Scrape(ctx)
			if prog.OnSourceDone != nil {
				prog.OnSourceDone(s.Name(), len(proxies), err)
			}
			if err != nil {
				fmt.Fprintf(stderrW, "[scraper] %s: %v\n", s.Name(), err)
				return
			}
			fmt.Fprintf(stderrW, "[scraper] %s: %d proxies\n", s.Name(), len(proxies))
			mu.Lock()
			for _, p := range proxies {
				if existing, ok := all[p.Key()]; ok {
					existing.Source = existing.Source + "," + p.Source
					all[p.Key()] = existing
				} else {
					all[p.Key()] = p
				}
			}
			mu.Unlock()
		}(s)
	}
	wg.Wait()

	out := make([]model.Proxy, 0, len(all))
	for _, p := range all {
		out = append(out, p)
	}
	return out
}

// SourceNames returns the display name of each scraper (useful for a TUI
// that wants to pre-populate the source list before scraping starts).
func SourceNames(scrapers []Scraper) []string {
	names := make([]string, len(scrapers))
	for i, s := range scrapers {
		names[i] = s.Name()
	}
	return names
}

// Default registers all built-in scrapers and filters by allowed types.
func Default(types []model.ProxyType) []Scraper {
	allowed := map[model.ProxyType]bool{}
	for _, t := range types {
		allowed[t] = true
	}
	want := func(t model.ProxyType) bool {
		if len(allowed) == 0 {
			return true
		}
		return allowed[t]
	}

	var s []Scraper
	if want(model.HTTP) || want(model.HTTPS) {
		s = append(s, &FreeProxyList{}, &SSLProxies{})
	}
	s = append(s, NewGitHubScrapers(want)...)
	s = append(s, NewProxyScrapeScrapers(want)...)
	if want(model.HTTP) {
		s = append(s, &ProxyNova{})
	}
	return s
}


var stderrW io.Writer = io.Discard

// SetLogger redirects scraper logs (default: discard).
func SetLogger(w io.Writer) { stderrW = w }
