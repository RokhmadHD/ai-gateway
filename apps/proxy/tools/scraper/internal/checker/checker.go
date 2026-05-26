package checker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/proxy"

	"github.com/tensanq/proxy-scraper/internal/model"
)

// Options controls how proxies are validated.
type Options struct {
	TargetURL   string        // expected to echo client IP (e.g. https://api.ipify.org)
	Timeout     time.Duration // per-request timeout
	Concurrency int           // parallel workers
	Logger      io.Writer
	// OnResult is invoked for every proxy after it has been tested.
	// Safe for concurrent calls (called from worker goroutines).
	OnResult func(p model.Proxy)
	// OnProgress is invoked at most once per completed proxy with cumulative
	// done/total counters. Safe for concurrent calls.
	OnProgress func(done, total int64)
}

// DefaultOptions returns sane defaults.
func DefaultOptions() Options {
	return Options{
		TargetURL:   "https://api.ipify.org",
		Timeout:     8 * time.Second,
		Concurrency: 200,
		Logger:      io.Discard,
	}
}

// Check validates every proxy concurrently. Returns the input slice with
// Alive/Latency/CheckedAt populated. Non-alive proxies keep Alive=false.
func Check(ctx context.Context, proxies []model.Proxy, opts Options) []model.Proxy {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 200
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 8 * time.Second
	}
	if opts.TargetURL == "" {
		opts.TargetURL = "https://api.ipify.org"
	}
	if opts.Logger == nil {
		opts.Logger = io.Discard
	}

	sem := make(chan struct{}, opts.Concurrency)
	var wg sync.WaitGroup
	var done int64
	total := int64(len(proxies))
	start := time.Now()

	out := make([]model.Proxy, len(proxies))
	for i := range proxies {
		out[i] = proxies[i]
	}

	for i := range out {
		i := i
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			alive, latency := testProxy(ctx, out[i], opts)
			out[i].Alive = alive
			out[i].Latency = latency
			out[i].CheckedAt = time.Now()

			if opts.OnResult != nil {
				opts.OnResult(out[i])
			}

			n := atomic.AddInt64(&done, 1)
			if opts.OnProgress != nil {
				opts.OnProgress(n, total)
			}
			if n%200 == 0 || n == total {
				elapsed := time.Since(start).Seconds()
				rate := float64(n) / elapsed
				fmt.Fprintf(opts.Logger, "[checker] %d/%d (%.0f/s)\n", n, total, rate)
			}
		}()
	}
	wg.Wait()
	return out
}

// testProxy returns (alive, latency).
func testProxy(ctx context.Context, p model.Proxy, opts Options) (bool, time.Duration) {
	client, err := buildClient(p, opts.Timeout)
	if err != nil {
		return false, 0
	}

	reqCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "GET", opts.TargetURL, nil)
	if err != nil {
		return false, 0
	}
	req.Header.Set("User-Agent", "curl/8.0")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return false, 0
	}
	defer resp.Body.Close()
	latency := time.Since(start)

	if resp.StatusCode >= 400 {
		return false, 0
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256))
	if err != nil {
		return false, 0
	}
	// api.ipify.org returns an IPv4 address; httpbin.org/ip returns JSON.
	text := strings.TrimSpace(string(body))
	if len(text) == 0 {
		return false, 0
	}
	return true, latency
}

func buildClient(p model.Proxy, timeout time.Duration) (*http.Client, error) {
	tr := &http.Transport{
		DisableKeepAlives:     true,
		MaxIdleConnsPerHost:   -1,
		ResponseHeaderTimeout: timeout,
		TLSHandshakeTimeout:   timeout,
		// Reject Transport's own keepalive dialer; we set a fresh one below.
	}

	switch p.Type {
	case model.HTTP, model.HTTPS, model.Unknown:
		u, err := url.Parse("http://" + p.Addr())
		if err != nil {
			return nil, err
		}
		tr.Proxy = http.ProxyURL(u)
		tr.DialContext = (&net.Dialer{Timeout: timeout}).DialContext

	case model.SOCKS4:
		// x/net/proxy lacks native SOCKS4 — use a minimal manual handshake.
		addr := p.Addr()
		tr.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
			return dialSocks4(ctx, addr, target, timeout)
		}

	case model.SOCKS5:
		dialer, err := proxy.SOCKS5("tcp", p.Addr(), nil, &net.Dialer{Timeout: timeout})
		if err != nil {
			return nil, err
		}
		cd, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return nil, errors.New("socks5 dialer does not support context")
		}
		tr.DialContext = cd.DialContext

	default:
		return nil, fmt.Errorf("unsupported proxy type: %s", p.Type)
	}

	return &http.Client{Transport: tr, Timeout: timeout}, nil
}
