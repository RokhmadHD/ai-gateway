"use client";

import { useState, type ReactNode } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Card, PageHeader, Badge, Button } from "@/components/ui";

export default function DocsPage() {
  return (
    <AuthGate>
      <Docs />
    </AuthGate>
  );
}

const PROXY_URL = "http://localhost:7777";

function Docs() {
  return (
    <>
      <PageHeader
        title="Docs"
        subtitle="Use cases sederhana — copy/paste, ganti token, jalan."
      />

      <div className="grid grid-cols-1 gap-4">
        <Section
          step="1"
          title="Bikin API key"
          body={
            <>
              <p>
                Buka <Link href="/api-keys">API Keys</Link> → <em>+ New key</em>{" "}
                → kasih nama (mis. <code>opencode-laptop</code>) → token
                tampil <strong>sekali</strong>, langsung copy. Format:{" "}
                <code className="text-xs">ap_xxxxxxxx…</code>.
              </p>
              <Callout tone="warning">
                Token gak bisa diambil ulang. Kalau kelupaan, revoke yang lama
                lalu bikin baru.
              </Callout>
            </>
          }
        />

        <Section
          step="2"
          title="Daftarkan provider + key"
          body={
            <p>
              Buka <Link href="/providers">Providers</Link> → pilih/buat
              provider (OpenAI, Anthropic, dll) → tab <em>Keys</em> → paste
              API key dari provider asli. Proxy yang nyimpan, client cuma pakai
              token <code>ap_…</code> di atas.
            </p>
          }
        />

        <Section
          step="3"
          title="Chat completions (OpenAI-compatible)"
          body={
            <>
              <p>Endpoint paling umum, drop-in pengganti OpenAI:</p>
              <Code lang="bash">{`curl ${PROXY_URL}/v1/chat/completions \\
  -H "Authorization: Bearer ap_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "halo" }
    ]
  }'`}</Code>
              <p className="text-xs text-(--color-text-muted)">
                Pakai SDK OpenAI? Cukup ganti <code>baseURL</code>:
              </p>
              <Code lang="ts">{`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${PROXY_URL}/v1",
  apiKey: "ap_YOUR_TOKEN",
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "halo" }],
});`}</Code>
            </>
          }
        />

        <Section
          step="4"
          title="Streaming (SSE)"
          body={
            <>
              <p>
                Tambah <code>{`"stream": true`}</code>. Proxy pass-through SSE
                tanpa buffer.
              </p>
              <Code lang="bash">{`curl -N ${PROXY_URL}/v1/chat/completions \\
  -H "Authorization: Bearer ap_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "messages": [{ "role": "user", "content": "tulis pantun" }]
  }'`}</Code>
            </>
          }
        />

        <Section
          step="5"
          title="Auto routing — biar proxy yang milih"
          body={
            <>
              <p>
                Set <code>model</code> = <code>aig-auto</code>. Proxy memilih
                provider eligible (active + ada key) sesuai bobot & cooldown.
                Respons membawa header <code>X-AIG-Provider</code> /{" "}
                <code>X-AIG-Model</code>.
              </p>
              <Code lang="bash">{`curl ${PROXY_URL}/v1/chat/completions \\
  -H "Authorization: Bearer ap_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "aig-auto",
    "messages": [{ "role": "user", "content": "tes" }]
  }'`}</Code>
            </>
          }
        />

        <Section
          step="6"
          title="Anthropic passthrough (/v1/messages)"
          body={
            <>
              <p>
                Kalau tools-mu (Claude Code, opencode) pakai format Anthropic,
                kirim ke <code>/v1/messages</code>. Body diteruskan apa adanya
                ke provider <code>endpoint_type=anthropic</code>.
              </p>
              <Code lang="bash">{`curl ${PROXY_URL}/v1/messages \\
  -H "Authorization: Bearer ap_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{ "role": "user", "content": "halo" }]
  }'`}</Code>
            </>
          }
        />

        <Section
          step="7"
          title="Monitor & atur"
          body={
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>
                <Link href="/snapshot">Live Snapshot</Link> — provider & key
                pool yang aktif di memory proxy.
              </li>
              <li>
                <Link href="/metrics">Token Metrics</Link> — pemakaian token
                per key/provider.
              </li>
              <li>
                Status key di-update otomatis (success/fail/cooldown). Bisa di
                <em>disable</em> manual dari halaman provider.
              </li>
            </ul>
          }
        />

        <Card>
          <div className="text-xs text-(--color-text-muted) uppercase tracking-wide mb-2">
            Cheat sheet
          </div>
          <table className="w-full text-sm">
            <tbody>
              <Row k="Base URL" v={<code>{PROXY_URL}</code>} />
              <Row
                k="Auth header"
                v={<code>Authorization: Bearer ap_…</code>}
              />
              <Row
                k="Endpoints"
                v={
                  <>
                    <code>/v1/chat/completions</code>,{" "}
                    <code>/v1/messages</code>
                  </>
                }
              />
              <Row
                k="Auto model"
                v={
                  <>
                    <code>aig-auto</code> <Badge tone="success">routed</Badge>
                  </>
                }
              />
              <Row
                k="Streaming"
                v={
                  <>
                    <code>{`"stream": true`}</code> → SSE pass-through
                  </>
                }
              />
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

function Section({
  step,
  title,
  body,
}: {
  step: string;
  title: string;
  body: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-full bg-(--color-accent)/15 text-(--color-accent) font-semibold text-sm flex items-center justify-center">
          {step}
        </div>
        <div className="flex-1 space-y-3">
          <div className="text-base font-semibold">{title}</div>
          <div className="space-y-3 text-sm">{body}</div>
        </div>
      </div>
    </Card>
  );
}

function Code({ children, lang }: { children: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-(--color-bg) border border-(--color-border) rounded px-3 py-2.5 text-xs font-mono overflow-x-auto whitespace-pre">
        {children}
      </pre>
      <Button
        variant="ghost"
        onClick={async () => {
          await navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{ position: "absolute", top: 6, right: 6, padding: "2px 8px" }}
      >
        {copied ? "✓" : lang ?? "copy"}
      </Button>
    </div>
  );
}

function Callout({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  const cls =
    tone === "warning"
      ? "bg-(--color-warning)/10 border-(--color-warning)/30 text-(--color-warning)"
      : "bg-(--color-accent)/10 border-(--color-accent)/30 text-(--color-text)";
  return (
    <div className={`text-xs border rounded px-3 py-2 ${cls}`}>{children}</div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <tr className="border-b border-(--color-border)/50 last:border-0">
      <td className="py-1.5 pr-3 text-(--color-text-muted) w-32">{k}</td>
      <td className="py-1.5">{v}</td>
    </tr>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="underline text-(--color-accent)">
      {children}
    </a>
  );
}
