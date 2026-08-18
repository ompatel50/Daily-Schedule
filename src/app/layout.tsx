import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import { Toaster } from "sonner";

import { ThemeProvider } from "@/components/layout/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Personal OS", template: "%s · Personal OS" },
  manifest: "/manifest.webmanifest",
  description:
    "A private, local-first personal operating system: daily planner, habits, nutrition, workouts and health in one place.",
  appleWebApp: {
    capable: true,
    title: "Personal OS",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the iPhone notch/home indicator; safe-area utilities in
  // globals.css pad the shell back out where content must not sit.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The per-request CSP nonce (set by src/proxy.ts). next-themes injects an
  // inline script to apply the stored theme before paint; under the
  // nonce-based script-src it must carry the nonce or the page flashes the
  // wrong theme with a console error. Absent outside the proxy (dev, tests).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster position="bottom-right" richColors closeButton />
          </TooltipProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
