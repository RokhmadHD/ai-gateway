# proxy-scraper

Engine Go untuk scraping daftar proxy gratis dari banyak sumber, mengecek
status hidup/mati tiap proxy, dan mendeteksi negara asal IP.
Dilengkapi **TUI interaktif (Bubble Tea)** untuk memantau progress real-time.

## Fitur
- **Multi-source scraping** — 15+ sumber paralel (GitHub raw lists, API, HTML).
- **Multi-protokol** — HTTP, HTTPS, SOCKS4, SOCKS5.
- **Checker konkuren** — worker pool (default 200) dengan timeout per-proxy.
- **GeoIP** — country / city / ISP via ip-api.com batch endpoint (gratis).
- **TUI Bubble Tea** — progress bar, source list, tabel alive proxy real-time.
- **Mode headless** — pipa-friendly untuk CI/cron (otomatis bila stdout bukan TTY).
- **Output fleksibel** — `.json`, `.csv`, atau `.txt` (auto by extension).
- **Single binary** — Go, ~11 MB, tanpa runtime dependency.

## Sumber yang di-scrape

| Sumber                                | Tipe                | Cara         |
|---------------------------------------|---------------------|--------------|
| free-proxy-list.net                   | HTTP/HTTPS          | goquery HTML |
| sslproxies.org                        | HTTPS               | goquery HTML |
| TheSpeedX/PROXY-List (GitHub)         | HTTP / SOCKS4/5     | raw text     |
| monosans/proxy-list (GitHub)          | HTTP / SOCKS4/5     | raw text     |
| proxifly/free-proxy-list (GitHub)     | HTTP / SOCKS4/5     | raw text     |
| proxyscrape.com API                   | HTTP / SOCKS4/5     | API text     |
| proxynova.com                         | HTTP                | JS-decoded   |

## Build
```bash
cd tools/scraper
go build -o proxy-scraper .
```

## Pemakaian
```bash
# TUI interaktif (otomatis bila stdout TTY)
./proxy-scraper -out=proxies.json

# Paksa headless (pipa / cron / CI)
./proxy-scraper -tui=off -out=proxies.json

# hanya SOCKS5 yang alive → TXT
./proxy-scraper -types=socks5 -alive-only -out=socks5.txt

# konkurensi tinggi, timeout pendek
./proxy-scraper -concurrency=500 -timeout=4s -out=fast.csv

# scrape saja, tanpa check & geo (paling cepat)
./proxy-scraper -check=false -geoip=false -out=raw.txt
```

## TUI

```
 ⚡ proxy-scraper   ◐ checking liveness                          1m 23s

╭─ Sources (15) ───────────────────╮  ╭─ Stats ──────────────────╮
│ ✓ free-proxy-list.net      315   │  │ Scraped       20130      │
│ ✓ sslproxies.org           115   │  │ Checked       4500 / 20130│
│ ✓ TheSpeedX/http           3156  │  │ Alive          287       │
│ ◐ proxyscrape/socks5             │  │ GeoIP          0 / 0     │
│ ○ proxynova.com                  │  │ Out file       proxies.json│
╰──────────────────────────────────╯  ╰──────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ Checking  4500/20130  •  287 alive  •  85/s                      │
│ ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                         │
╰──────────────────────────────────────────────────────────────────╯

╭─ Top alive (sorted by latency, 25 shown) ──────────────────────╮
│ TYPE    ADDRESS              CC   LATENCY  SOURCE              │
│ http    1.2.3.4:8080         US   120ms    TheSpeedX/http      │
│ socks5  5.6.7.8:1080         DE   250ms    monosans/socks5     │
│ …                                                              │
╰────────────────────────────────────────────────────────────────╯
 [q] quit
```

Tekan `q` atau `Ctrl-C` untuk keluar.

## Flag

| Flag            | Default                  | Catatan                                         |
|-----------------|--------------------------|-------------------------------------------------|
| `-tui`          | `auto`                   | `auto` / `on` / `off`. Auto = on bila TTY       |
| `-types`        | `http,socks4,socks5`     | komma-separated, sebagian dari di atas          |
| `-check`        | `true`                   | uji hidup/mati                                  |
| `-geoip`        | `true`                   | resolve country/city/ISP                        |
| `-alive-only`   | `false`                  | output hanya yang lolos check                   |
| `-concurrency`  | `200`                    | worker paralel untuk checker                    |
| `-timeout`      | `8s`                     | timeout per proxy                               |
| `-target`       | `https://api.ipify.org`  | URL test (harus echo IP)                        |
| `-out`          | `proxies.json`           | path output, format dari ekstensi               |
| `-quiet`        | `false`                  | matikan log progress (headless mode)            |

## Format output

**JSON** — struktur lengkap (`Proxy` model: ip, port, type, country,
country_code, city, isp, latency_ms, alive, source, anonymous, checked_at).

**TXT** — satu proxy per baris: `socks5://1.2.3.4:1080 | ID | 320ms`.

**CSV** — siap di-import ke spreadsheet / DB.

## Catatan teknis

- **GeoIP rate limit**: ip-api.com gratis = 15 req/menit × 100 IP/batch ≈
  1500 IP/menit. Untuk volume tinggi, ganti ke MaxMind GeoLite2 offline.
- **SOCKS4**: handshake manual (paket `x/net/proxy` tidak punya native
  SOCKS4). Hanya target IPv4; hostname diresolve lokal.
- **HTTPS proxy**: untuk CONNECT-tunneling diperlakukan sama seperti HTTP
  (`tr.Proxy = http.ProxyURL`); flag `https` di sumber hanya menandakan
  proxy mampu meneruskan koneksi TLS.
- **Deduplikasi**: kombinasi `type://ip:port` jadi kunci; sumber digabung
  dengan koma jika muncul di lebih dari satu list.

## Struktur folder

```
tools/scraper/
├── main.go                       # CLI + dispatch TUI/headless
├── go.mod
└── internal/
    ├── model/proxy.go            # tipe data
    ├── scraper/
    │   ├── scraper.go            # interface + RunAll + Default + Progress
    │   ├── freeproxylist.go      # free-proxy-list.net + sslproxies
    │   ├── github.go             # TheSpeedX + monosans + proxifly
    │   ├── proxyscrape.go        # proxyscrape API
    │   └── proxynova.go          # proxynova (decode JS obfuscation)
    ├── checker/
    │   ├── checker.go            # worker pool + transport builder
    │   └── socks4.go             # SOCKS4 handshake manual
    ├── geoip/geoip.go            # ip-api.com batch lookup
    └── tui/
        ├── tui.go                # Bubble Tea model + view + pipeline
        ├── messages.go           # typed tea.Msg events
        └── styles.go             # lipgloss palette
```
