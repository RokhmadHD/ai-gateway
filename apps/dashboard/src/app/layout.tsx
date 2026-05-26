import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "AI Gateway",
  description: "Control-plane dashboard for ai-gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="flex flex-col md:flex-row min-h-screen">
            <Sidebar />
            <main className="flex-1 px-4 md:px-8 py-4 md:py-6 overflow-x-auto">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
