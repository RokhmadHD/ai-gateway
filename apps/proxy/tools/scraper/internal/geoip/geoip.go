package geoip

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tensanq/proxy-scraper/internal/model"
)

// Lookup hydrates Country / CountryCode / City / ISP for every proxy using
// ip-api.com's free batch endpoint (100 IPs / call, 15 calls / minute).
//
// Proxies that already have a non-empty CountryCode are skipped.
//
// onProgress (optional) is called after each batch with (done, total) where
// the counts refer to unique IPs being looked up — not proxies.
func Lookup(ctx context.Context, proxies []model.Proxy, logger io.Writer, onProgress func(done, total int)) []model.Proxy {
	if logger == nil {
		logger = io.Discard
	}
	out := make([]model.Proxy, len(proxies))
	copy(out, proxies)

	type batchReq struct {
		Query  string `json:"query"`
		Fields string `json:"fields,omitempty"`
	}
	type batchResp struct {
		Status      string  `json:"status"`
		Country     string  `json:"country"`
		CountryCode string  `json:"countryCode"`
		City        string  `json:"city"`
		ISP         string  `json:"isp"`
		Query       string  `json:"query"`
		Message     string  `json:"message,omitempty"`
	}

	// Build a unique IP list for proxies missing geo data.
	idxByIP := map[string][]int{}
	for i, p := range out {
		if p.CountryCode != "" {
			continue
		}
		idxByIP[p.IP] = append(idxByIP[p.IP], i)
	}
	if len(idxByIP) == 0 {
		return out
	}
	ips := make([]string, 0, len(idxByIP))
	for ip := range idxByIP {
		ips = append(ips, ip)
	}

	const batchSize = 100
	throttle := time.NewTicker(4 * time.Second) // 15 calls/min -> 4s gap
	defer throttle.Stop()

	client := &http.Client{Timeout: 20 * time.Second}

	for start := 0; start < len(ips); start += batchSize {
		end := start + batchSize
		if end > len(ips) {
			end = len(ips)
		}
		batch := make([]batchReq, 0, end-start)
		for _, ip := range ips[start:end] {
			batch = append(batch, batchReq{
				Query:  ip,
				Fields: "status,country,countryCode,city,isp,query",
			})
		}

		body, _ := json.Marshal(batch)
		req, _ := http.NewRequestWithContext(ctx, "POST",
			"http://ip-api.com/batch?fields=status,country,countryCode,city,isp,query",
			bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			fmt.Fprintf(logger, "[geoip] batch error: %v\n", err)
			<-throttle.C
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var results []batchResp
		if err := json.Unmarshal(raw, &results); err != nil {
			fmt.Fprintf(logger, "[geoip] unmarshal: %v\n", err)
			<-throttle.C
			continue
		}
		for _, r := range results {
			if r.Status != "success" {
				continue
			}
			for _, idx := range idxByIP[r.Query] {
				out[idx].Country = r.Country
				out[idx].CountryCode = r.CountryCode
				out[idx].City = r.City
				out[idx].ISP = r.ISP
			}
		}
		fmt.Fprintf(logger, "[geoip] %d/%d resolved\n", end, len(ips))
		if onProgress != nil {
			onProgress(end, len(ips))
		}

		if end < len(ips) {
			<-throttle.C
		}
	}
	return out
}
