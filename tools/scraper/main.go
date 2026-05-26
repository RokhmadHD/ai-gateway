package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/mattn/go-isatty"

	"github.com/tensanq/proxy-scraper/internal/checker"
	"github.com/tensanq/proxy-scraper/internal/geoip"
	"github.com/tensanq/proxy-scraper/internal/model"
	"github.com/tensanq/proxy-scraper/internal/scraper"
	"github.com/tensanq/proxy-scraper/internal/tui"
)

func main() {
	var (
		typesArg   = flag.String("types", "http,socks4,socks5", "comma-separated proxy types to include")
		doCheck    = flag.Bool("check", true, "test each proxy for liveness")
		doGeo      = flag.Bool("geoip", true, "resolve country/city via ip-api.com")
		onlyAlive  = flag.Bool("alive-only", false, "output only proxies that passed the live check")
		conc       = flag.Int("concurrency", 200, "number of concurrent liveness checks")
		timeoutDur = flag.Duration("timeout", 8*time.Second, "per-proxy check timeout")
		target     = flag.String("target", "https://api.ipify.org", "URL used to validate a proxy")
		outFile    = flag.String("out", "proxies.json", "output file (.json / .txt / .csv inferred from extension)")
		quiet      = flag.Bool("quiet", false, "suppress progress logs (text mode only)")
		useTUI     = flag.String("tui", "auto", "TUI mode: auto | on | off")
		progress   = flag.Bool("progress", false, "emit JSON-line progress events to stderr (works alongside -quiet)")
	)
	flag.Parse()

	types := parseTypes(*typesArg)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	tuiOn := false
	switch *useTUI {
	case "on":
		tuiOn = true
	case "off":
		tuiOn = false
	default:
		tuiOn = isatty.IsTerminal(os.Stdout.Fd())
	}

	opts := tui.Options{
		Types:       types,
		Check:       *doCheck,
		GeoIP:       *doGeo,
		AliveOnly:   *onlyAlive,
		Concurrency: *conc,
		Timeout:     *timeoutDur,
		Target:      *target,
		OutFile:     *outFile,
	}

	if tuiOn {
		runTUI(ctx, opts)
		return
	}
	runHeadless(ctx, opts, *quiet, *progress)
}

func runTUI(ctx context.Context, opts tui.Options) {
	_, proxies, err := tui.Run(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tui error: %v\n", err)
		os.Exit(1)
	}
	if len(proxies) == 0 {
		fmt.Fprintln(os.Stderr, "no proxies collected")
		return
	}
	if err := writeOutput(opts.OutFile, proxies); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", opts.OutFile, err)
		os.Exit(1)
	}
	alive := 0
	for _, p := range proxies {
		if p.Alive {
			alive++
		}
	}
	fmt.Printf("✓ %d proxies (%d alive) saved to %s\n", len(proxies), alive, opts.OutFile)
}

func runHeadless(ctx context.Context, opts tui.Options, quiet bool, progress bool) {
	logger := os.Stderr
	if quiet {
		f, _ := os.Open(os.DevNull)
		logger = f
	}
	scraper.SetLogger(logger)

	// Progress events go to stderr as one JSON object per line. Independent of
	// -quiet so Node-side parents can pipe them without enabling human logs.
	var progMu sync.Mutex
	emit := func(event string, fields map[string]any) {
		if !progress {
			return
		}
		if fields == nil {
			fields = map[string]any{}
		}
		fields["event"] = event
		fields["ts"] = time.Now().UnixMilli()
		progMu.Lock()
		defer progMu.Unlock()
		_ = json.NewEncoder(os.Stderr).Encode(fields)
	}

	scrapers := scraper.Default(opts.Types)
	emit("phase", map[string]any{"name": "scraping", "sources_total": len(scrapers)})
	fmt.Fprintln(logger, "→ scraping sources...")

	var sourcesDone int64
	proxies := scraper.RunAll(ctx, scrapers, scraper.Progress{
		OnSourceStart: func(name string) {
			emit("source_start", map[string]any{"name": name})
		},
		OnSourceDone: func(name string, count int, err error) {
			n := atomic.AddInt64(&sourcesDone, 1)
			f := map[string]any{"name": name, "count": count, "done": n, "total": int64(len(scrapers))}
			if err != nil {
				f["err"] = err.Error()
			}
			emit("source_done", f)
		},
	})
	emit("phase", map[string]any{"name": "scraped", "scraped": len(proxies)})
	fmt.Fprintf(logger, "→ scraped %d unique proxies from %d sources\n", len(proxies), len(scrapers))

	if opts.Check {
		emit("phase", map[string]any{"name": "checking", "check_total": len(proxies)})
		fmt.Fprintln(logger, "→ checking liveness...")
		copts := checker.DefaultOptions()
		copts.Concurrency = opts.Concurrency
		copts.Timeout = opts.Timeout
		copts.TargetURL = opts.Target
		copts.Logger = logger
		var aliveSoFar int64
		var lastEmit int64
		copts.OnResult = func(p model.Proxy) {
			if p.Alive {
				atomic.AddInt64(&aliveSoFar, 1)
			}
		}
		copts.OnProgress = func(done, total int64) {
			// Throttle: emit every 100 completions or at completion.
			if done == total || done-atomic.LoadInt64(&lastEmit) >= 100 {
				atomic.StoreInt64(&lastEmit, done)
				emit("check_progress", map[string]any{
					"done":  done,
					"total": total,
					"alive": atomic.LoadInt64(&aliveSoFar),
				})
			}
		}
		proxies = checker.Check(ctx, proxies, copts)

		alive := 0
		for _, p := range proxies {
			if p.Alive {
				alive++
			}
		}
		emit("phase", map[string]any{"name": "checked", "alive": alive, "total": len(proxies)})
		fmt.Fprintf(logger, "→ alive: %d / %d\n", alive, len(proxies))
	}

	if opts.AliveOnly {
		proxies = filterAlive(proxies)
	}

	if opts.GeoIP && len(proxies) > 0 {
		emit("phase", map[string]any{"name": "geoip", "count": len(proxies)})
		fmt.Fprintln(logger, "→ resolving geoip...")
		proxies = geoip.Lookup(ctx, proxies, logger, nil)
	}

	sort.Slice(proxies, func(i, j int) bool {
		if proxies[i].Alive != proxies[j].Alive {
			return proxies[i].Alive
		}
		return proxies[i].Latency < proxies[j].Latency
	})

	emit("phase", map[string]any{"name": "writing", "count": len(proxies)})
	if err := writeOutput(opts.OutFile, proxies); err != nil {
		emit("error", map[string]any{"err": err.Error()})
		fmt.Fprintf(os.Stderr, "write %s: %v\n", opts.OutFile, err)
		os.Exit(1)
	}
	emit("done", map[string]any{"written": len(proxies), "path": opts.OutFile})
	fmt.Fprintf(logger, "→ wrote %d proxies to %s\n", len(proxies), opts.OutFile)
}

func parseTypes(s string) []model.ProxyType {
	var out []model.ProxyType
	for _, raw := range strings.Split(s, ",") {
		t := strings.ToLower(strings.TrimSpace(raw))
		switch t {
		case "http":
			out = append(out, model.HTTP)
		case "https":
			out = append(out, model.HTTPS)
		case "socks4":
			out = append(out, model.SOCKS4)
		case "socks5":
			out = append(out, model.SOCKS5)
		}
	}
	return out
}

func filterAlive(in []model.Proxy) []model.Proxy {
	out := in[:0]
	for _, p := range in {
		if p.Alive {
			out = append(out, p)
		}
	}
	return out
}

func writeOutput(path string, proxies []model.Proxy) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	switch {
	case strings.HasSuffix(path, ".json"):
		enc := json.NewEncoder(f)
		enc.SetIndent("", "  ")
		return enc.Encode(proxies)

	case strings.HasSuffix(path, ".csv"):
		w := csv.NewWriter(f)
		_ = w.Write([]string{"ip", "port", "type", "alive", "latency_ms", "country", "country_code", "city", "isp", "source"})
		for _, p := range proxies {
			_ = w.Write([]string{
				p.IP,
				fmt.Sprintf("%d", p.Port),
				string(p.Type),
				fmt.Sprintf("%t", p.Alive),
				fmt.Sprintf("%d", p.Latency.Milliseconds()),
				p.Country,
				p.CountryCode,
				p.City,
				p.ISP,
				p.Source,
			})
		}
		w.Flush()
		return w.Error()

	default: // .txt
		for _, p := range proxies {
			fmt.Fprintf(f, "%s://%s:%d", p.Type, p.IP, p.Port)
			if p.CountryCode != "" {
				fmt.Fprintf(f, " | %s", p.CountryCode)
			}
			switch {
			case p.CheckedAt.IsZero():
				// liveness check disabled — no status to print
			case p.Alive:
				fmt.Fprintf(f, " | %dms", p.Latency.Milliseconds())
			default:
				fmt.Fprintf(f, " | DEAD")
			}
			fmt.Fprintln(f)
		}
		return nil
	}
}
